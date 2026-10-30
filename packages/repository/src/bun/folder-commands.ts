/**
 * `epicenter sync`: one folder engine (`bun/folder.ts`) over a folder. Live,
 * it keeps the folder live, each quiet window's saves going to the replica
 * as they happen; `--once` is "send now": catch up, read every difference
 * from the record, send what can go, and report what cannot. Each file
 * goes on its own: a held file waits alone with its reason. Who runs it
 * changes only the author label.
 *
 * It prints one JSON value per line with `json`, else the same as plain
 * lines: `joined`, `caught-up`, `held` (path and reason), `pending` (the
 * commit in flight, if any), `stopped`. Exit codes: 0 done, 1 usage or
 * environment, 2 work not landed (held, pending).
 */
import { openFolderEngine, type FolderOptions, type OpenedFolder } from './folder.js';

/** One line of a command's output. */
export type Line =
	| { joined: string | null; replica: string; agent?: string }
	| { 'caught-up': string | null }
	| { held: { path: string; reason: string }[] }
	| { pending: string | null }
	| { stopped: true }
	| { error: string };

export type Print = (line: Line) => void;

/** Render a line for a person. */
export function plain(line: Line): string {
	if ('joined' in line) return `Joined ${line.joined ?? 'a repository kept only here'} (replica ${line.replica.slice(0, 8)}${line.agent === undefined ? '' : `, as ${line.agent}`})`;
	if ('caught-up' in line) return `Caught up at ${line['caught-up']?.slice(0, 7) ?? 'nothing yet'}`;
	if ('held' in line) return `Held: ${line.held.map((h) => `${h.path} (${h.reason})`).join(', ')}`;
	if ('pending' in line) return `Pending${line.pending === null ? '' : ` ${line.pending.slice(0, 7)}`}: it goes with the next sync`;
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
			const held = replica.held();
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
