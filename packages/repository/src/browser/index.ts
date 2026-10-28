/**
 * The browser host. Each repository is one SQLite file in this origin's
 * private storage, and one tab owns it: that tab holds the repository's Web
 * Lock and runs the worker that opens the database and the server
 * connection. Its repository talks to that worker alone.
 *
 * Another tab opening the same repository finds the lock taken and shows
 * `elsewhere`; its Use here takes the lock (`steal`), which rejects the old
 * tab's lock request: that rejection is how the old tab learns it has
 * `moved`. The old tab closes its worker after the writes it already sent,
 * and never takes the repository back unless the person asks. The new tab's
 * worker waits (`waiting`) until the old one has released the database.
 *
 * An owning tab also closes its worker when the page is hidden for good or
 * frozen (`pagehide`, `freeze`), so a background tab never holds the
 * database, and opens it again when the page comes back, if no other tab
 * took it meanwhile. Nothing is resent between tabs: a batch the old worker
 * sent without hearing back is resent by the next one under its number, and
 * the server answers it from its receipt.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import type { Result } from 'wellcrafted/result';
import { type App, type Definitions, type Live, type Settled, WriteError } from '../define.js';
import type { EngineAnswers, EngineRequest, Submitted } from '../engine/engine.js';
import { createRepository, type EnginePort, type Repository } from '../repository.js';
import { type Described, type Init, lockName, REPOSITORY_NAME, type TabMessage, type WorkerMessage } from './messages.js';

export const BrowserRepositoryError = defineErrors({
	/** The worker could not open the database in this origin's private storage. */
	Unavailable: ({ reason }: { reason: string }) => ({
		message: `This browser could not open the repository: ${reason}`,
		reason,
	}),
});
export type BrowserRepositoryError = InferErrors<typeof BrowserRepositoryError>;

export type BrowserRepositoryOptions<TDefs extends Definitions> = {
	app: App<TDefs>;
	/** The repository's name in this origin: one database, one lock and one owning tab per name. */
	name: string;
	/** The server to sync with; without one the repository works on this device alone. */
	server?: { url: string };
	/** Start the owning tab's worker; by default the package's own worker module. */
	worker?: () => Worker;
	log?: Logger;
};

/** Where this tab stands with its repository. */
export type TabState<TDefs extends Definitions> =
	| { status: 'opening' }
	/** This tab owns the repository, but another tab's worker has not released the database yet. */
	| { status: 'waiting'; reason: string }
	| { status: 'open'; repository: Repository<TDefs> }
	/** Another tab owns the repository. `useHere` takes it from that tab. */
	| { status: 'elsewhere'; useHere(): void }
	/** Another tab took the repository from this one. It stays there until `useHere`. */
	| { status: 'moved'; useHere(): void }
	| { status: 'unavailable'; error: BrowserRepositoryError; retry(): void }
	| { status: 'closed' };

/**
 * One tab's hold on a repository. `subscribe` calls back with the current
 * state and then with every change, so it is a `Live` and the Svelte `live`
 * adapter renders it.
 */
export type RepositoryTab<TDefs extends Definitions> = Live<TabState<TDefs>> & {
	state(): TabState<TDefs>;
	/** Close the repository in this tab and give the lock up. */
	close(): void;
};

const describe = (app: App): Described =>
	Object.fromEntries(
		app.lenses.map((lens) => [
			lens.name,
			lens.kind === 'note'
				? { path: lens.template.source, fields: lens.fields }
				: { path: lens.template.source, blob: { types: [...lens.blob.types], maxSize: lens.blob.maxSize } },
		]),
	);

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void };
const deferred = <T>(): Deferred<T> => {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
};

const closedError = () => new Error('The repository is closed');
const closedSubmit = (): Submitted => ({ local: Promise.resolve(WriteError.Closed()), settled: Promise.resolve(WriteError.Closed()) });

/**
 * Open a repository in this tab. The tab takes the repository when no other
 * tab owns it; otherwise it stands `elsewhere` until the person chooses Use
 * here.
 */
export function openBrowserRepository<const TDefs extends Definitions>({
	app,
	name,
	server,
	worker = () => new Worker(new URL('./repository.worker.ts', import.meta.url), { type: 'module' }),
	log = createLogger('repository/browser'),
}: BrowserRepositoryOptions<TDefs>): RepositoryTab<TDefs> {
	// A bad name is a mistake in the app's source.
	if (!REPOSITORY_NAME.test(name)) throw new Error(`'${name}' is not a usable repository name`);

	let state: TabState<TDefs> = { status: 'opening' };
	const watchers = new Set<(state: TabState<TDefs>) => void>();
	const set = (next: TabState<TDefs>) => {
		state = next;
		for (const watcher of watchers) watcher(next);
	};

	/** The worker this tab runs while it owns the repository, and how to end it. */
	type Session = { ended: Promise<void>; end(): void };
	let session: Session | null = null;
	let closed = false;
	/** Whether the page was hidden while owning, so showing it again opens the repository again. */
	let reopen = false;
	/** The latest lock request, which settles once its lock is released. */
	let held: Promise<unknown> = Promise.resolve();

	function startSession(): Session {
		const running = worker();
		let next = 1;
		const reads = new Map<number, Deferred<unknown>>();
		const writes = new Map<number, { local: Deferred<Result<undefined, WriteError>>; settled: Deferred<Result<Settled[], WriteError>> }>();
		const changes = new Set<(paths: string[] | null) => void>();
		const ended = deferred<undefined>();
		let ending = false;
		let finished = false;
		const post = (message: TabMessage) => running.postMessage(message);
		/** Whether this session still decides what the tab shows. */
		const current = () => session === me && !ending;

		/** The worker is gone: every call still waiting is answered as closed. */
		function finish() {
			if (finished) return;
			finished = true;
			running.terminate();
			for (const read of reads.values()) read.reject(closedError());
			reads.clear();
			for (const write of writes.values()) {
				write.local.resolve(WriteError.Closed());
				write.settled.resolve(WriteError.Closed());
			}
			writes.clear();
			changes.clear();
			ended.resolve(undefined);
		}

		const port: EnginePort = {
			read<TRequest extends EngineRequest>(request: TRequest) {
				if (ending) return Promise.reject(closedError());
				const id = next++;
				const answer = deferred<unknown>();
				reads.set(id, answer);
				post({ type: 'read', id, request });
				return answer.promise as Promise<EngineAnswers[TRequest['kind']]>;
			},
			submit(ops): Submitted {
				if (ending) return closedSubmit();
				const id = next++;
				const write = { local: deferred<Result<undefined, WriteError>>(), settled: deferred<Result<Settled[], WriteError>>() };
				writes.set(id, write);
				post({ type: 'submit', id, ops });
				return { local: write.local.promise, settled: write.settled.promise };
			},
			onChange(listener) {
				changes.add(listener);
				return () => {
					changes.delete(listener);
				};
			},
			close: () => tab.close(),
		};

		running.onmessage = (event: MessageEvent<WorkerMessage>) => {
			const message = event.data;
			switch (message.type) {
				case 'waiting':
					if (current()) set({ status: 'waiting', reason: message.reason });
					return;
				case 'ready':
					if (current()) set({ status: 'open', repository: createRepository(app, port, { log }) });
					return;
				case 'unavailable': {
					const { error } = BrowserRepositoryError.Unavailable({ reason: message.reason });
					if (current()) set({ status: 'unavailable', error, retry: () => take('available') });
					finish();
					return;
				}
				case 'answer':
				case 'failed': {
					const read = reads.get(message.id);
					reads.delete(message.id);
					if (message.type === 'answer') read?.resolve(message.value);
					else read?.reject(new Error(message.reason));
					return;
				}
				case 'local':
					writes.get(message.id)?.local.resolve(message.result);
					return;
				case 'settled': {
					const write = writes.get(message.id);
					writes.delete(message.id);
					write?.local.resolve(message.result.error === null ? { data: undefined, error: null } : message.result);
					write?.settled.resolve(message.result);
					return;
				}
				case 'changed':
					for (const listener of changes) listener(message.paths);
					return;
				case 'closed':
					finish();
					return;
				default:
					message satisfies never;
			}
		};
		running.addEventListener('error', (event) => {
			const reason = event.message || 'the worker failed to start';
			log.error({ name: 'WorkerFailed', message: reason });
			if (current()) set({ status: 'unavailable', error: BrowserRepositoryError.Unavailable({ reason }).error, retry: () => take('available') });
			finish();
		});
		post({ type: 'init', name, definitions: describe(app), server: server ?? null } satisfies Init);

		const me: Session = {
			ended: ended.promise,
			/** Refuse new calls, let the worker finish the ones already sent, then let it go. */
			end() {
				if (ending) return;
				ending = true;
				if (finished) return;
				post({ type: 'close' });
			},
		};
		return me;
	}

	/** Ask for the lock: only if no tab holds it, or by taking it from the tab that does. */
	function take(how: 'available' | 'steal') {
		if (closed) return;
		set({ status: 'opening' });
		let mine: Session | null = null;
		held = navigator.locks
			.request(lockName(name), how === 'steal' ? { steal: true } : { ifAvailable: true }, async (lock) => {
				if (lock === null) {
					set({ status: 'elsewhere', useHere: () => take('steal') });
					return;
				}
				if (closed) return;
				mine = startSession();
				session = mine;
				// Held until this tab closes the repository, hides, or loses it.
				await mine.ended;
			})
			.catch((cause: unknown) => {
				if (mine === null) {
					// The request itself failed; no worker ran.
					const reason = cause instanceof Error ? cause.message : String(cause);
					set({ status: 'unavailable', error: BrowserRepositoryError.Unavailable({ reason }).error, retry: () => take('available') });
					return;
				}
				// Another tab took the repository with Use here. This tab stops,
				// after the writes it already sent, and takes the repository back
				// only when the person asks.
				const lost = mine;
				lost.end();
				if (session === lost) {
					session = null;
					set({ status: 'moved', useHere: () => take('steal') });
				}
			});
	}

	/** The page is going away or freezing: save what was sent and let the database go. */
	const hide = () => {
		if (session === null) return;
		const hidden = session;
		session = null;
		reopen = true;
		hidden.end();
		set({ status: 'opening' });
	};
	/** The page is back: open the repository again once the old worker has let it go. */
	const show = () => {
		if (!reopen) return;
		reopen = false;
		void held.finally(() => take('available'));
	};
	addEventListener('pagehide', hide);
	addEventListener('pageshow', show);
	document.addEventListener('freeze', hide);
	document.addEventListener('resume', show);

	const tab: RepositoryTab<TDefs> = {
		state: () => state,
		subscribe(onChange) {
			watchers.add(onChange);
			onChange(state);
			return () => {
				watchers.delete(onChange);
			};
		},
		close() {
			if (closed) return;
			closed = true;
			removeEventListener('pagehide', hide);
			removeEventListener('pageshow', show);
			document.removeEventListener('freeze', hide);
			document.removeEventListener('resume', show);
			session?.end();
			session = null;
			set({ status: 'closed' });
			watchers.clear();
		},
	};
	take('available');
	return tab;
}
