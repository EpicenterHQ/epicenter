/**
 * `epicenter sync` and `epicenter commit`: one folder engine
 * (`bun/folder.ts`) with two timings. `sync` keeps a folder live, each
 * quiet window's saves going to the replica as they happen, each its own
 * call. `commit -m` sends every difference from the record as one call
 * carrying the message, through the same replica, landing whole or held
 * whole, and reports what the replica says became of that call. Who runs
 * them changes only the author label.
 *
 * Each prints one JSON value per line with `json`, else the same as plain
 * lines: `joined`, `caught-up`, `landed` (the commit, with `conflicts` and
 * `kept`), `held` (path and reason), `pending` (the commit in flight, if
 * any), `unchanged`, `stopped`. Exit codes: 0 done, 1 usage or
 * environment, 2 work not landed (held, pending).
 */
import type { CallOutcome } from '../client/replica.js';
import { openFolderEngine, type FolderOptions, type OpenedFolder } from './folder.js';

/** One line of a command's output. */
export type Line =
	| { joined: string | null; replica: string; agent?: string }
	| { 'caught-up': string | null }
	| { landed: string; conflicts: string[]; kept: string[] }
	| { held: { path: string; reason: string }[] }
	| { pending: string | null }
	| { unchanged: true }
	| { stopped: true }
	| { error: string };

export type Print = (line: Line) => void;

/** Render a line for a person. */
export function plain(line: Line): string {
	if ('joined' in line) return `Joined ${line.joined ?? 'a repository kept only here'} (replica ${line.replica.slice(0, 8)}${line.agent === undefined ? '' : `, as ${line.agent}`})`;
	if ('caught-up' in line) return `Caught up at ${line['caught-up']?.slice(0, 7) ?? 'nothing yet'}`;
	if ('landed' in line)
		return `Landed ${line.landed.slice(0, 7)}${line.conflicts.length === 0 ? '' : `; conflict blocks in ${line.conflicts.join(', ')}`}${line.kept.length === 0 ? '' : `; kept ${line.kept.join(', ')} (a delete that did not take)`}`;
	if ('held' in line) return `Held: ${line.held.map((h) => `${h.path} (${h.reason})`).join(', ')}`;
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
			const held = [...engine.held(), ...replica.held()];
			if (held.length > 0) print({ held });
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

/** A call's outcome as a line. */
function lineOf(outcome: CallOutcome): Line {
	switch (outcome.kind) {
		case 'landed':
			return { landed: outcome.commit, conflicts: outcome.conflicts, kept: outcome.kept };
		case 'held':
			return { held: outcome.held };
		case 'pending':
			return { pending: outcome.commit };
	}
}

/**
 * Send everything that differs in `dir` from the record as one call
 * carrying `message`, and wait (at most `wait` ms) for what becomes of it.
 * With nothing new, the commits earlier runs left unsent (calls with a
 * message) are waited for and reported instead.
 */
export async function commit(options: FolderOptions & { message: string; wait?: number }, print: Print): Promise<number> {
	const folder = await open(options, print);
	if (folder === null) return 1;
	const { replica, engine } = folder;
	let link: ReturnType<OpenedFolder['connect']> = null;
	try {
		// Before connecting: no remote change can project into a file the commit is reading, and the record holds what the call read when answers come.
		const { call } = await engine.commit(options.message);
		// Files in the folder the repository cannot take are not in the commit: they are named, and it goes without them.
		const kept = engine.held();
		if (kept.length > 0) print({ held: kept });
		const calls = call !== null ? [call] : replica.calls().flatMap((earlier) => (earlier.message === null ? [] : [earlier.call]));
		if (calls.length === 0) {
			print({ unchanged: true });
			return 0;
		}
		link = folder.connect();
		const outcomes = () => calls.map((each) => replica.outcome(each));
		await until(() => outcomes().every((outcome) => outcome.kind !== 'pending'), link === null ? 0 : (options.wait ?? 30_000));
		// Landed: catch up, so the folder holds what landed, conflict blocks and all.
		if (link !== null && outcomes().some((outcome) => outcome.kind === 'landed')) {
			await until(() => !replica.busy(), 5_000);
			await engine.idle();
		}
		let code = 0;
		for (const outcome of outcomes()) {
			print(lineOf(outcome));
			if (outcome.kind !== 'landed') code = 2;
		}
		return code;
	} finally {
		await engine.stop();
		link?.close();
		folder.close();
	}
}
