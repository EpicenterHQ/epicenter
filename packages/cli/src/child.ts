/**
 * An action runs in its own process (ADR-0850). The `epicenter` a person or
 * `serve` started only relays: it spawns this same `epicenter` with the
 * internal `--report=<file>` flag, gives the child its stdin and its stderr
 * as both of the child's output streams, forwards SIGINT and SIGTERM, and
 * reads the child's answer from the report file once the child exits. So
 * nothing an action writes to stdout, through any `console` method or
 * `process.stdout`, can reach the answer.
 *
 * The report is a file rather than a pipe because every process the child
 * starts (Git, its hooks, anything an action leaves running) inherits an open
 * descriptor, and a pipe's reader waits for all of them. The child writes
 * `{ answer }` when it ends, by renaming over the file, so the parent reads a
 * whole answer or none. A child that ends without a report answers that it
 * threw (exit 1), naming its exit code or signal; whatever it wrote stays on
 * disk, pending until a snapshot with no call.
 *
 * The child owns the whole call: it takes the app's lock, runs the action,
 * and commits what it wrote (`run.ts`), so it finishes the call, commit and
 * all, even when its parent dies.
 *
 * A parent that wants an action's yields (ADR-0879) opens Bun's IPC channel
 * to the child, and the child sends each yield over it as `{ yielded }`. Bun
 * delivers every message before the child's exit is seen, so the yields all
 * arrive before the answer is read. A child with no channel sends nothing.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { epicenterDir } from './root.ts';

/** The internal flag that makes `epicenter` a child writing its answer to a file; undocumented, and read only as the first argument, so an action's own input can never be taken for it. */
export const REPORT_FLAG = '--report=';

/**
 * The internal flag, read only right after the report flag, that lets the
 * child run a read-only action and nothing else: a connector with only the
 * `read` scope calls through it, so the check sits where the action is found
 * (ADR-0871).
 */
export const READ_ONLY_FLAG = '--read-only-call';

/** Whether this `epicenter` is the compiled binary, which is Bun itself under `BUN_BE_BUN=1`. */
export const COMPILED = Bun.main.startsWith('/$bunfs/');

/** How to run this same `epicenter`: the compiled binary alone, or Bun, with the flags it was started with, and this entry. */
function self(): string[] {
	return COMPILED
		? [process.execPath]
		: [process.execPath, ...process.execArgv, Bun.main];
}

/** What a child reports: its one JSON answer. */
export type Report = { answer: unknown };

/** Write `record` to the report file in one rename, so a reader never sees half of it. */
export function writeReport(path: string, record: Report) {
	const temp = `${path}.${randomUUID()}`;
	writeFileSync(temp, `${JSON.stringify(record)}\n`);
	renameSync(temp, path);
}

/**
 * Run `epicenter <args>` as a child and return the one JSON value it
 * answered: for a call, an `Answer`, after the child has committed what it
 * wrote; for a listing, the listing. The command line and both MCP
 * transports run every call this way. With `readOnly`, the child runs an
 * action only when it is read-only, and no command at all. With `onYield`,
 * each value the action yields goes to it in order, each delivery awaited
 * before the next and all before the answer returns; when `signal` aborts,
 * the child is stopped, so a call nobody is waiting for ends unanswered.
 */
export async function runChild(
	args: string[],
	stdin: 'inherit' | 'ignore',
	{
		readOnly = false,
		onYield,
		signal,
	}: {
		readOnly?: boolean;
		onYield?: (value: unknown) => unknown;
		signal?: AbortSignal;
	} = {},
): Promise<unknown> {
	const path = join(tmpdir(), `epicenter-report-${randomUUID()}.json`);
	const flags = [
		`${REPORT_FLAG}${path}`,
		...(readOnly ? [READ_ONLY_FLAG] : []),
	];
	let delivered: Promise<unknown> = Promise.resolve();
	const child = Bun.spawn([...self(), ...flags, ...args], {
		cwd: epicenterDir(),
		stdio: [stdin, 2, 2],
		...(onYield && {
			serialization: 'json' as const,
			ipc(message: { yielded?: unknown }) {
				delivered = delivered
					.then(() => onYield(message.yielded))
					.catch(() => {});
			},
		}),
	});
	const forward = (signal: NodeJS.Signals) => child.kill(signal);
	const stop = () => child.kill('SIGTERM');
	process.on('SIGINT', forward);
	process.on('SIGTERM', forward);
	signal?.addEventListener('abort', stop, { once: true });
	let record: Partial<Report> = {};
	try {
		await child.exited;
		await delivered;
		try {
			record = JSON.parse(readFileSync(path, 'utf8'));
		} catch {}
	} finally {
		process.off('SIGINT', forward);
		process.off('SIGTERM', forward);
		signal?.removeEventListener('abort', stop);
		rmSync(path, { force: true });
	}
	if ('answer' in record) return record.answer;
	const ended =
		child.signalCode === null
			? `exit code ${child.exitCode}`
			: `signal ${child.signalCode}`;
	return { threw: { message: `The run ended without an answer (${ended})` } };
}
