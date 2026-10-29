/**
 * The in-process host: a replica in this process (Bun, a script, a test),
 * served to the repository as its worker would serve a page. Every answer
 * and every change arrives asynchronously and in order, a change before the
 * answer to the write that made it, as across a worker's messages.
 *
 * `end()` stops the session as a worker's loss would (calls in flight and
 * later ones reject, and the repository shows `opening`); `resume()` opens a
 * new one, over the same replica or another opened on the same database.
 */
import { type Collection, type PageServer, servePage } from '../client/page.js';
import type { Replica } from '../client/replica.js';
import type { App, Definitions, Lens } from '../core/lens.js';
import { type Host, type HostState, openRepository, type Repository, type Session } from './repository.js';

/** An app's note collections as a replica serves them. */
export function collectionsOf(app: { lenses: Lens[] }): Collection[] {
	return app.lenses.flatMap((lens) => (lens.kind === 'note' ? [{ name: lens.name, view: lens.view, template: lens.template, memory: lens.memory }] : []));
}

const ended = () => Promise.reject(new Error('The session ended'));

function sessionOver(page: PageServer, alive: () => boolean): Session {
	const answer = <T>(run: () => T): Promise<T> => (alive() ? Promise.resolve().then(() => (alive() ? run() : ended())) : ended());
	return {
		snapshot: () => answer(() => page.snapshot()),
		row: (path) => answer(() => page.read(path)),
		query: (sql, params) => answer(() => page.query(sql, params)),
		change(changes, token) {
			if (!alive()) return ended();
			// Applied when called, in order, as a worker applies messages in order; answered after the changes it made are heard.
			const result = page.change(changes, token);
			return Promise.resolve().then(() => (alive() ? result : ended()));
		},
		watch(listener) {
			return page.watch((delta) =>
				queueMicrotask(() => {
					if (alive()) listener(delta);
				}),
			);
		},
	};
}

/** Serve `replica` in this process; `end` and `resume` stand in for a worker's loss and a new one. */
export function createLocalHost({ replica, app }: { replica: Replica; app: { lenses: Lens[] } }) {
	const watchers = new Set<(state: HostState) => void>();
	let state: HostState = { status: 'opening' };
	let generation = 0;
	let stopPage: (() => void) | null = null;
	const set = (next: HostState) => {
		state = next;
		for (const watcher of watchers) watcher(next);
	};
	function start(over: Replica) {
		const mine = ++generation;
		const page = servePage(over, collectionsOf(app));
		const alive = () => generation === mine;
		// The page's own watch on the replica stops with the session.
		const stops: (() => void)[] = [];
		const session = sessionOver(
			{
				...page,
				watch(listener) {
					const stop = page.watch(listener);
					stops.push(stop);
					return stop;
				},
			},
			alive,
		);
		stopPage = () => {
			for (const stop of stops.splice(0)) stop();
		};
		set({ status: 'open', session });
	}
	const host: Host = {
		// A process has no page to hide or freeze: its session ends only when it is told to.
		leaving: () => () => {},
		subscribe(onState) {
			watchers.add(onState);
			onState(state);
			return () => {
				watchers.delete(onState);
			};
		},
		close() {
			generation++;
			stopPage?.();
			set({ status: 'closed' });
			watchers.clear();
		},
	};
	queueMicrotask(() => {
		if (state.status === 'opening') start(replica);
	});
	return {
		host,
		/** The session ends, as when a worker is lost. */
		end(next: Exclude<HostState, { status: 'open' }> = { status: 'opening' }) {
			generation++;
			stopPage?.();
			set(next);
		},
		/** A new session, over `over` (by default the same replica). */
		resume(over: Replica = replica) {
			start(over);
		},
	};
}

/** Open `app`'s repository over a replica in this process. */
export function openLocalRepository<TDefs extends Definitions>({ app, replica }: { app: App<TDefs>; replica: Replica }): Repository<TDefs> {
	return openRepository({ app, host: createLocalHost({ replica, app: app }).host });
}
