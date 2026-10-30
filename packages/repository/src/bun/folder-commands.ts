/**
 * `epicenter sync`: one folder engine (`bun/folder.ts`) over a folder. Live,
 * it keeps the folder live, each quiet window's saves going to the replica
 * as they happen; `--once` is "send now": catch up, read every difference
 * from the record, send what can go, and report each file. Each file goes
 * on its own: one that cannot go waits (the system clears it) or is refused
 * (only a person can fix it), alone, with its reason. Who runs it changes
 * only the author label.
 *
 * It prints one JSON value per line with `json`, else the same as plain
 * lines: `joined`, `caught-up`, `landed` (each file sent and how it
 * landed: as sent, with conflict blocks, at a sibling, or a delete that did
 * not take), `waiting` and `refused` (path and reason), `pending` (the
 * seq of the push in flight, if any), `stopped`. Exit codes: 0 done, 1 usage or
 * environment, 2 work not landed (waiting, refused, pending).
 */
import type { Outcome } from '../client/replica.js';
import {
	type FolderOptions,
	type OpenedFolder,
	openFolderEngine,
} from './folder.js';

/** One line of a command's output. */
export type Line =
	| { joined: string | null; replica: string; agent?: string }
	| { 'caught-up': string | null }
	| { landed: { path: string; outcome: Outcome }[] }
	| { waiting: { path: string; reason: string }[] }
	| { refused: { path: string; reason: string }[] }
	| { pending: number | null }
	| { stopped: true }
	| { error: string };

export type Print = (line: Line) => void;

/** How a sent file landed, after its path. */
const HOW: Record<Outcome['kind'], string> = {
	landed: '',
	blocks: ' (with conflict blocks)',
	sibling: ' (lost to another write; kept beside it)',
	'delete-did-not-take': ' (the delete did not take: it changed elsewhere)',
};

/** Render a line for a person. */
export function plain(line: Line): string {
	if ('joined' in line)
		return `Joined ${line.joined ?? 'a repository kept only here'} (replica ${line.replica.slice(0, 8)}${line.agent === undefined ? '' : `, as ${line.agent}`})`;
	if ('caught-up' in line)
		return `Caught up at ${line['caught-up']?.slice(0, 7) ?? 'nothing yet'}`;
	if ('landed' in line)
		return `Landed: ${line.landed.map(({ path, outcome }) => (outcome.kind === 'sibling' ? `${path} (lost to another write; kept beside it at ${outcome.at})` : `${path}${HOW[outcome.kind]}`)).join(', ')}`;
	if ('waiting' in line)
		return `Waiting: ${line.waiting.map((h) => `${h.path} (${h.reason})`).join(', ')}`;
	if ('refused' in line)
		return `Refused, to fix: ${line.refused.map((h) => `${h.path} (${h.reason})`).join(', ')}`;
	if ('pending' in line)
		return `Pending${line.pending === null ? '' : ` push ${line.pending}`}: it goes with the next sync`;
	if ('stopped' in line) return 'Stopped';
	return `Error: ${line.error}`;
}

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wait until `done` holds, polling, at most `ms`: whether it held. */
async function until(done: () => boolean, ms: number) {
	for (const end = Date.now() + ms; Date.now() < end; await sleep(50))
		if (done()) return true;
	return done();
}

async function open(
	options: FolderOptions,
	print: Print,
): Promise<OpenedFolder | null> {
	const opened = await openFolderEngine(options);
	if (opened.error !== null) {
		print({ error: opened.error.message });
		return null;
	}
	if (opened.data.joined)
		print({
			joined: opened.data.identity.repository,
			replica: opened.data.identity.replica,
			...(opened.data.identity.agent === undefined
				? {}
				: { agent: opened.data.identity.agent }),
		});
	return opened.data;
}

/**
 * Keep `dir` live until `stop` resolves (a signal), or with `once` until
 * everything is sent: catch up, scan, then watch. On stop, what is in
 * flight is given 5 s to finish.
 */
export async function sync(
	options: FolderOptions & { once?: boolean; stop?: Promise<void> },
	print: Print,
): Promise<number> {
	const folder = await open(options, print);
	if (folder === null) return 1;
	const { replica, engine } = folder;
	const link = folder.connect();
	try {
		// The startup scan comes after the first catch-up when online, so it reads the folder against what the server has.
		if (link !== null)
			await until(() => replica.position() !== null && !replica.busy(), 10_000);
		print({ 'caught-up': replica.position() });
		await engine.start({ watch: options.once !== true });
		/** Print how each sent file landed, then what is not sent; whether anything is not. */
		const report = () => {
			const landed = replica.outcomes();
			if (landed.length > 0) print({ landed });
			const notSent = replica.notSent();
			const of = (status: 'waiting' | 'refused') =>
				notSent
					.filter((file) => file.status === status)
					.map(({ path, reason }) => ({ path, reason }));
			if (of('waiting').length > 0) print({ waiting: of('waiting') });
			if (of('refused').length > 0) print({ refused: of('refused') });
			return notSent.length > 0;
		};
		if (options.once === true) {
			await engine.idle();
			if (link !== null)
				await until(
					() => !replica.busy() && replica.owed().length === 0,
					30_000,
				);
			const held = report();
			if (held || replica.unsent().length > 0) {
				print({ pending: replica.sent()?.seq ?? null });
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
