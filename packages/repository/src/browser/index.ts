/**
 * The browser host. Each repository is one SQLite file in this origin's
 * private storage, owned by one leader tab's worker; every tab, the leader
 * included, calls that worker over the repository's BroadcastChannel.
 *
 * Every tab stands for leader with the repository's Web Lock. The tab that
 * holds it starts the worker, which opens the database and the server
 * connection and announces itself. When the leader tab closes, its lock and
 * worker go with it; the next tab in line starts its own worker, and each
 * tab sends its unanswered calls again. A write's call id is its command id,
 * stored with its outbox rows in the same transaction, so a write the old
 * leader applied is found by the new one and answered, never applied twice.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Ok, type Result } from 'wellcrafted/result';
import { type App, type Definitions, type Settled, WriteError } from '../define.js';
import type { EngineAnswers, EngineRequest, Submitted, WriteOp } from '../engine/engine.js';
import { createRepository, type EnginePort, type Repository } from '../repository.js';
import {
	channelName,
	type Described,
	type Init,
	type LeaderMessage,
	lockName,
	REPOSITORY_NAME,
	type TabMessage,
} from './messages.js';

export const BrowserRepositoryError = defineErrors({
	/** The leader could not open the database in this origin's private storage. */
	Unavailable: ({ reason }: { reason: string }) => ({
		message: `This browser could not open the repository: ${reason}`,
		reason,
	}),
});
export type BrowserRepositoryError = InferErrors<typeof BrowserRepositoryError>;

export type BrowserRepositoryOptions<TDefs extends Definitions> = {
	app: App<TDefs>;
	/** The repository's name in this origin: one database, one lock and one leader per name. */
	name: string;
	/** The server to sync with; without one the repository works on this device alone. */
	server?: { url: string };
	/** Start the leader's worker; by default the package's own worker module. */
	worker?: () => Worker;
	log?: Logger;
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

/**
 * Open a repository in this tab. Resolves once a leader, this tab's or
 * another's, answers; until a leader exists calls wait.
 */
export async function openBrowserRepository<const TDefs extends Definitions>({
	app,
	name,
	server,
	worker = () => new Worker(new URL('./repository.worker.ts', import.meta.url), { type: 'module' }),
	log = createLogger('repository/browser'),
}: BrowserRepositoryOptions<TDefs>): Promise<Result<Repository<TDefs>, BrowserRepositoryError>> {
	// A bad name is a mistake in the app's source.
	if (!REPOSITORY_NAME.test(name)) throw new Error(`'${name}' is not a usable repository name`);
	const tab = crypto.randomUUID();
	const channel = new BroadcastChannel(channelName(name));
	const post = (message: TabMessage) => channel.postMessage(message);

	const reads = new Map<string, { request: EngineRequest; answer: Deferred<unknown> }>();
	const writes = new Map<string, { ops: WriteOp[]; local: Deferred<Result<undefined, WriteError>> | null; settled: Deferred<Result<Settled[], WriteError>> }>();
	const listeners = new Set<(paths: string[] | null) => void>();
	const ready = deferred<Result<undefined, BrowserRepositoryError>>();
	let leader: string | null = null;
	let unavailable: BrowserRepositoryError | null = null;

	const sendRead = (id: string, request: EngineRequest) => post({ type: 'read', tab, id, request });
	const sendWrite = (id: string, ops: WriteOp[]) => post({ type: 'submit', tab, id, ops });

	channel.onmessage = (event: MessageEvent<LeaderMessage>) => {
		const message = event.data;
		switch (message.type) {
			case 'leader': {
				if (message.leader === leader) return;
				const first = leader === null;
				leader = message.leader;
				ready.resolve(Ok(undefined));
				// A new leader never saw what the old one left unanswered: ask again.
				for (const [id, { request }] of reads) sendRead(id, request);
				for (const [id, { ops }] of writes) sendWrite(id, ops);
				if (!first) for (const listener of listeners) listener(null);
				return;
			}
			case 'unavailable': {
				const { error } = BrowserRepositoryError.Unavailable({ reason: message.reason });
				unavailable = error;
				ready.resolve(BrowserRepositoryError.Unavailable({ reason: message.reason }));
				for (const { answer } of reads.values()) answer.reject(error);
				reads.clear();
				return;
			}
			case 'changed':
				for (const listener of listeners) listener(message.paths);
				return;
			case 'answer':
			case 'failed': {
				if (message.tab !== tab) return;
				const read = reads.get(message.id);
				if (read === undefined) return;
				reads.delete(message.id);
				if (message.type === 'answer') read.answer.resolve(message.value);
				else read.answer.reject(new Error(message.reason));
				return;
			}
			case 'local': {
				if (message.tab !== tab) return;
				const write = writes.get(message.id);
				if (write?.local == null) return;
				write.local.resolve(message.result);
				write.local = null;
				return;
			}
			case 'settled': {
				if (message.tab !== tab) return;
				const write = writes.get(message.id);
				if (write === undefined) return;
				writes.delete(message.id);
				write.local?.resolve(message.result.error === null ? Ok(undefined) : message.result);
				write.settled.resolve(message.result);
				return;
			}
			default:
				message satisfies never;
		}
	};

	// Stand for leader. The callback holds the lock until this tab closes the
	// repository or closes itself, which ends the worker too.
	let closed = false;
	const released = deferred<undefined>();
	let started: Worker | null = null;
	void navigator.locks.request(lockName(name), async () => {
		if (closed) return;
		started = worker();
		started.addEventListener('error', (event) => {
			log.error({ name: 'WorkerFailed', message: event.message || 'The repository worker failed to start' });
			channel.postMessage({ type: 'unavailable', reason: event.message || 'the worker failed to start' } satisfies LeaderMessage);
			ready.resolve(BrowserRepositoryError.Unavailable({ reason: event.message || 'the worker failed to start' }));
		});
		started.postMessage({ type: 'init', name, definitions: describe(app), server: server ?? null } satisfies Init);
		await released.promise;
		started.terminate();
	});
	post({ type: 'hello' });

	const port: EnginePort = {
		read<TRequest extends EngineRequest>(request: TRequest) {
			if (unavailable !== null) return Promise.reject(unavailable);
			if (closed) return Promise.reject(new Error('The repository is closed'));
			const id = crypto.randomUUID();
			const answer = deferred<unknown>();
			reads.set(id, { request, answer });
			sendRead(id, request);
			return answer.promise as Promise<EngineAnswers[TRequest['kind']]>;
		},
		submit(command, ops): Submitted {
			if (closed) return { local: Promise.resolve(WriteError.Closed()), settled: Promise.resolve(WriteError.Closed()) };
			const local = deferred<Result<undefined, WriteError>>();
			const settled = deferred<Result<Settled[], WriteError>>();
			writes.set(command, { ops, local, settled });
			sendWrite(command, ops);
			return { local: local.promise, settled: settled.promise };
		},
		onChange(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		close() {
			closed = true;
			released.resolve(undefined);
			channel.close();
			listeners.clear();
			for (const write of writes.values()) {
				write.local?.resolve(WriteError.Closed());
				write.settled.resolve(WriteError.Closed());
			}
			writes.clear();
			for (const { answer } of reads.values()) answer.reject(new Error('The repository is closed'));
			reads.clear();
		},
	};

	const opened = await ready.promise;
	if (opened.error !== null) {
		port.close();
		return opened;
	}
	return Ok(createRepository(app, port, { log }));
}
