/**
 * `epicenter sync` and `epicenter commit`: one folder engine
 * (`bun/folder.ts`) with two timings. `sync` keeps a folder live, each
 * quiet window's saves going to the replica as they happen, each its own
 * call. `commit -m` sends every difference from the record as one call
 * carrying the message, through the same replica, landing whole or held
 * whole. Who runs them changes only the author label.
 *
 * Each prints one JSON value per line with `json`, else the same as plain
 * lines: `joined`, `caught-up`, `sent`, `landed` (with `conflicts`),
 * `held` (path and reason), `unreadable` (path and reason), `pending`,
 * `unchanged`, `stopped`. Exit codes: 0 done, 1 usage or environment, 2
 * work not landed (held, pending).
 */
import { findConflicts } from '../core/conflict.js';
import { openFolderEngine, type FolderOptions, type OpenedFolder } from './folder.js';

/** One line of a command's output. */
export type Line =
	| { joined: string | null; replica: string; agent?: string }
	| { 'caught-up': string | null }
	| { sent: string[] }
	| { landed: string; conflicts: string[] }
	| { held: { path: string; reason: string }[]; commit: string | null }
	| { unreadable: { path: string; reason: string }[] }
	| { pending: string | null }
	| { unchanged: true }
	| { stopped: true }
	| { error: string };

export type Print = (line: Line) => void;

/** Render a line for a person. */
export function plain(line: Line): string {
	if ('joined' in line) return `Joined ${line.joined ?? 'a repository kept only here'} (replica ${line.replica.slice(0, 8)}${line.agent === undefined ? '' : `, as ${line.agent}`})`;
	if ('caught-up' in line) return `Caught up at ${line['caught-up']?.slice(0, 7) ?? 'nothing yet'}`;
	if ('sent' in line) return `Sent ${line.sent.join(', ')}`;
	if ('landed' in line) return `Landed ${line.landed.slice(0, 7)}${line.conflicts.length === 0 ? '' : `; conflict blocks in ${line.conflicts.join(', ')}`}`;
	if ('held' in line) return `Held: ${line.held.map((h) => `${h.path} (${h.reason})`).join(', ')}`;
	if ('unreadable' in line) return `Unreadable: ${line.unreadable.map((u) => `${u.path} (${u.reason})`).join(', ')}`;
	if ('pending' in line) return `Pending${line.pending === null ? '' : ` ${line.pending.slice(0, 7)}`}: it goes with the next commit or sync`;
	if ('unchanged' in line) return 'Nothing differs from the last sync';
	if ('stopped' in line) return 'Stopped';
	return `Error: ${line.error}`;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wait until `done` holds, polling, at most `ms`: whether it held. */
async function until(done: () => boolean, ms: number) {
	for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (done()) return true;
	return done();
}

async function open(options: FolderOptions, print: Print): Promise<OpenedFolder | null> {
	const opened = await openFolderEngine(options);
	if (opened.error !== null) {
		print({ error: opened.error.message });
		return null;
	}
	if (opened.data.joined) print({ joined: opened.data.identity.repository, replica: opened.data.identity.replica, ...(opened.data.identity.agent === undefined ? {} : { agent: opened.data.identity.agent }) });
	return opened.data;
}

/**
 * Keep `dir` live until `stop` resolves (a signal), or with `once` until
 * everything is sent: catch up, scan, then watch. On stop, what is in
 * flight is given 5 s to finish.
 */
export async function sync(options: FolderOptions & { once?: boolean; stop?: Promise<void> }, print: Print): Promise<number> {
	const folder = await open(options, print);
	if (folder === null) return 1;
	const { replica, engine } = folder;
	const link = folder.connect();
	try {
		// The startup scan comes after the first catch-up when online, so it reads the folder against what the server has.
		if (link !== null) await until(() => replica.position() !== null && !replica.busy(), 10_000);
		print({ 'caught-up': replica.position() });
		await engine.start({ watch: options.once !== true });
		const report = () => {
			const unreadable = engine.unreadable();
			if (unreadable.length > 0) print({ unreadable });
			const held = replica.held();
			if (held.length > 0) print({ held, commit: null });
		};
		if (options.once === true) {
			await engine.idle();
			if (link !== null) await until(() => !replica.busy() && replica.owed().length === 0, 30_000);
			report();
			if (replica.unsent().length > 0) {
				print({ pending: replica.sent()?.id ?? null });
				return 2;
			}
			print({ stopped: true });
			return 0;
		}
		await (options.stop ?? new Promise<void>(() => {}));
		await until(() => !replica.busy(), 5_000);
		report();
		print({ stopped: true });
		return engine.failure() === null ? 0 : 1;
	} finally {
		await engine.stop();
		link?.close();
		folder.close();
	}
}

/**
 * Send everything that differs in `dir` from the record as one commit
 * carrying `message`, and wait (at most `wait` ms) for its verdict. A
 * commit pending from an earlier run goes too, once.
 */
export async function commit(options: FolderOptions & { message: string; wait?: number }, print: Print): Promise<number> {
	const folder = await open(options, print);
	if (folder === null) return 1;
	const { replica, engine } = folder;
	let link: ReturnType<OpenedFolder['connect']> = null;
	try {
		// Before connecting: no remote change can project into a file the commit is reading, and the record holds what the group read when answers come.
		const saved = await engine.commit(options.message);
		const unreadable = engine.unreadable();
		if (unreadable.length > 0) print({ unreadable });
		if (saved.length === 0 && replica.unsent().length === 0) {
			print({ unchanged: true });
			return 0;
		}
		const read = new Map(saved.map((path) => [path, findConflicts(replica.read(path) ?? '').length]));
		const group = new Set(saved);
		let id: string | null = null;
		// The commit's id, as soon as the replica sends it: it may land between two looks.
		const unwatch = replica.watch(() => {
			const sent = replica.sent();
			if (sent?.message === options.message) id = sent.id;
		});
		link = folder.connect();
		if (link === null) {
			print({ pending: null });
			return 2;
		}
		/** What holds the group: its own held files, or those it was saved with. */
		const heldHere = () => replica.held();
		const settled = () => {
			return heldHere().length > 0 || [...group].every((path) => replica.state(path).status === 'synced');
		};
		await until(settled, options.wait ?? 30_000);
		unwatch();
		const held = heldHere();
		if (held.length > 0 && [...group].some((path) => replica.state(path).status === 'held')) {
			print({ held, commit: id });
			return 2;
		}
		if (![...group].every((path) => replica.state(path).status === 'synced')) {
			print({ pending: id ?? replica.sent()?.id ?? null });
			return 2;
		}
		// Landed: catch up, so a conflict block the merge wrote reaches the file, and name where it wrote one.
		await until(() => !replica.busy(), 5_000);
		await engine.idle();
		const conflicts = [...group].filter((path) => path.endsWith('.md') && findConflicts(replica.read(path) ?? '').length > (read.get(path) ?? 0));
		print({ landed: id ?? 'unknown', conflicts });
		return 0;
	} finally {
		await engine.stop();
		link?.close();
		folder.close();
	}
}
