/**
 * `keepEverySynced`: the Epicenter app keeping every folder in the
 * Epicenter folder in sync while it runs, with or without a window
 * (ADR-0819). It runs `syncEvery`, the one sync function behind one request
 * for where every folder is, at the moments an open app syncs its own
 * folder (`syncAtMoments`):
 *
 * | Moment | What runs |
 * | --- | --- |
 * | it starts | a round |
 * | a burst of changes in a folder | a round, `afterChangeMs` after the last |
 * | every `checkEveryMs` | a round: one request for every folder's head, and a sync of each folder that moved on either side |
 * | `now()` (Sync pressed) | a round |
 *
 * One round runs at a time: every moment that comes while one runs makes a
 * single round after it. It hears a folder's changes through its store's
 * watch, which a round starts for each folder it finds and stops for one
 * that went. It stops when disposed or when the account is retired.
 *
 * Each folder carries a mark (ADR-0788, ADR-0789, ADR-0801, ADR-0807): ✓
 * `synced`, ◌ `waiting` (a change not yet synced, or a folder with no folder
 * on the server yet), ⚠ `conflict` (a note a merge
 * left with conflict blocks, until they are resolved), and ✗ `refused` (the
 * server refused a file, or the sync could not run), with why.
 */
import type { RemoteAccount } from '../remote/repository.js';
import type { EpicenterRoot, LocalFolder } from './epicenter-folder.js';
import { type EverySync, type FolderSync, syncEvery } from './sync-folder.js';

/** A folder's mark, by what its last round left. */
export type FolderMark =
	/** ✓ It agrees with its folder on the server. */
	| { mark: 'synced' }
	/**
	 * ◌ It waits: a change here not yet synced (`changed`), or a folder that
	 * has no folder on the server yet (`local`: never synced, or a copy of
	 * another folder, which stays local).
	 */
	| { mark: 'waiting'; why: 'changed' | 'local' }
	/** ⚠ Notes a merge left holding conflict blocks. */
	| { mark: 'conflict'; paths: string[] }
	/** ✗ The server refused files (`paths`), or the sync could not run (none). */
	| { mark: 'refused'; reason: string; paths: string[] };

/** What the loop knows now. */
export type KeptState = {
	/** Each folder's mark, by its path. */
	marks: ReadonlyMap<string, FolderMark>;
	/** Whether a round runs now. */
	syncing: boolean;
	/** How the last round ended (null before the first): when, and why it could not run. */
	last: { at: number; error: string | null } | null;
};

/** How long after the last change of a burst a round runs. */
const AFTER_CHANGE_MS = 3000;
/** How often a round asks where every folder is. */
const CHECK_EVERY_MS = 3000;

const decoder = new TextDecoder();

/** Whether `text` holds a conflict block a merge wrote. */
const holdsConflict = (text: string) =>
	/^<{7} /m.test(text) && /^>{7} /m.test(text);

/** The paths among `paths` in `local` whose notes still hold a conflict block. */
async function stillConflicted(local: LocalFolder, paths: readonly string[]) {
	const read = await local.store.read(paths);
	if (read.error !== null) return [...paths];
	return read.data.flatMap((file) =>
		'gone' in file || !holdsConflict(decoder.decode(file.bytes))
			? []
			: [file.path],
	);
}

/** The mark a folder's sync left. */
function markOf(sync: FolderSync): FolderMark {
	if (sync.kind !== 'synced') return { mark: 'waiting', why: 'local' };
	const { refused, conflicts } = sync.report;
	if (refused.length > 0)
		return {
			mark: 'refused',
			reason: refused
				.map(({ path, reason }) => `${path}: ${reason}`)
				.join('; '),
			paths: refused.map(({ path }) => path),
		};
	if (conflicts.length > 0) return { mark: 'conflict', paths: conflicts };
	return { mark: 'synced' };
}

/**
 * Keep every folder in `root` in sync as `account`, at the moments above.
 * `changed` hears each time the state may answer differently.
 */
export function keepEverySynced({
	account,
	root,
	afterChangeMs = AFTER_CHANGE_MS,
	checkEveryMs = CHECK_EVERY_MS,
}: {
	account: RemoteAccount;
	root: EpicenterRoot;
	afterChangeMs?: number;
	checkEveryMs?: number;
}) {
	let marks = new Map<string, FolderMark>();
	let syncing = false;
	let last: KeptState['last'] = null;
	let state: KeptState = { marks, syncing, last };
	let stopped = false;
	const listeners = new Set<() => void>();
	/** Each folder's watch, by its path. */
	const watches = new Map<string, { local: LocalFolder; stop: () => void }>();
	let running: Promise<EverySync[] | null> | null = null;
	let queued: Promise<EverySync[] | null> | null = null;
	let changeTimer: ReturnType<typeof setTimeout> | undefined;
	let checkTimer: ReturnType<typeof setTimeout> | undefined;

	function publish() {
		state = { marks, syncing, last };
		for (const listener of [...listeners]) listener();
	}

	/** How many changes were heard, and when each folder last changed, by that count. */
	let changesHeard = 0;
	const heardAt = new Map<string, number>();

	/** A change heard in the folder at `path`: ◌ now, and a round after the burst. */
	function heard(path: string) {
		if (stopped) return;
		changesHeard++;
		heardAt.set(path, changesHeard);
		const mark = marks.get(path);
		if (mark?.mark !== 'refused' && mark?.mark !== 'conflict') {
			marks = new Map(marks).set(path, { mark: 'waiting', why: 'changed' });
			publish();
		}
		clearTimeout(changeTimer);
		changeTimer = setTimeout(() => {
			changeTimer = undefined;
			void request();
		}, afterChangeMs);
	}

	/** Watch every folder `every` names, and stop watching the ones gone. */
	async function watchEvery(every: readonly EverySync[]) {
		const present = new Set<string>();
		for (const { local } of every) {
			present.add(local.path);
			const kept = watches.get(local.path);
			if (kept?.local === local) continue;
			kept?.stop();
			watches.delete(local.path);
			const watched = await local.store.watch(() => heard(local.path));
			if (stopped) {
				if (watched.error === null) watched.data();
				return;
			}
			if (watched.error === null)
				watches.set(local.path, { local, stop: watched.data });
		}
		for (const [path, { stop }] of watches)
			if (!present.has(path)) {
				stop();
				watches.delete(path);
			}
	}

	async function round(): Promise<EverySync[] | null> {
		if (stopped) return null;
		const began = changesHeard;
		syncing = true;
		publish();
		const every = await syncEvery({ account, root });
		syncing = false;
		if (stopped) return null;
		if (every.error !== null) {
			last = { at: Date.now(), error: every.error.message };
			publish();
			return null;
		}
		const next = new Map<string, FolderMark>();
		for (const entry of every.data) {
			const { local, result, waiting } = entry;
			const before = marks.get(local.path);
			let mark: FolderMark;
			if (waiting) mark = { mark: 'waiting', why: 'local' };
			else if ((heardAt.get(local.path) ?? 0) > began)
				// Changed while this round ran: the next round takes it up.
				mark = { mark: 'waiting', why: 'changed' };
			else if (result === undefined)
				// Nothing moved: what the last sync left stands, but a sync that
				// could not run before is no reason to show ✗ now.
				mark =
					before?.mark === 'conflict' ||
					(before?.mark === 'refused' && before.paths.length > 0)
						? before
						: { mark: 'synced' };
			else if (result.error !== null)
				mark = { mark: 'refused', reason: result.error.message, paths: [] };
			else mark = markOf(result.data);
			// A conflict lasts until its notes no longer hold a block.
			if (mark.mark === 'conflict') {
				const paths = await stillConflicted(local, mark.paths);
				mark =
					paths.length > 0 ? { mark: 'conflict', paths } : { mark: 'synced' };
			}
			next.set(local.path, mark);
		}
		marks = next;
		// Watching before the round says it ended, so a change made after is heard.
		await watchEvery(every.data);
		if (stopped) return null;
		last = { at: Date.now(), error: null };
		publish();
		return every.data;
	}

	/** A round now, or once after the round running now. */
	function request(): Promise<EverySync[] | null> {
		if (stopped) return Promise.resolve(null);
		if (running === null) {
			running = round().finally(() => {
				running = null;
			});
			return running;
		}
		if (queued === null) {
			const next = () => {
				queued = null;
				return request();
			};
			queued = running.then(next, next);
		}
		return queued;
	}

	function schedule() {
		clearTimeout(checkTimer);
		if (stopped) return;
		checkTimer = setTimeout(async () => {
			if (running === null) await request();
			schedule();
		}, checkEveryMs);
	}

	function stop() {
		if (stopped) return;
		stopped = true;
		clearTimeout(changeTimer);
		clearTimeout(checkTimer);
		for (const { stop: unwatch } of watches.values()) unwatch();
		watches.clear();
		account.signal.removeEventListener('abort', stop);
		listeners.clear();
	}

	if (account.signal.aborted) stopped = true;
	else {
		account.signal.addEventListener('abort', stop, { once: true });
		void request();
		schedule();
	}

	return {
		/** The marks, whether a round runs, and how the last ended. */
		state: (): KeptState => state,
		/** Call `listener` whenever `state()` may answer differently; returns the unsubscribe. */
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		/**
		 * A round now (Sync pressed), or once the round running now ends:
		 * each folder's part, or null once stopped or when the round could
		 * not ask the server.
		 */
		now: request,
		/** Stop: no moment runs a round after this; a round running now finishes. */
		[Symbol.dispose]: stop,
	};
}

export type KeptFolders = ReturnType<typeof keepEverySynced>;
