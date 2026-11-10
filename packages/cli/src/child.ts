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
 * whole answer or none; after a run that is not read-only it adds `wrote`,
 * the app, call, and paths the parent then commits. A child that ends without
 * a report answers that it threw (exit 1), naming its exit code or signal;
 * whatever it wrote stays on disk, pending until a snapshot with no call.
 *
 * The child finishes the run even when its parent dies: nothing it does
 * depends on the parent being there.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeErr } from './output.ts';
import { epicenterDir } from './root.ts';
import { snapshot, type Wrote } from './snapshot.ts';

/** The internal flag that makes `epicenter` a child writing its answer to a file; undocumented, and read only as the first argument, so an action's own input can never be taken for it. */
export const REPORT_FLAG = '--report=';

/** Whether this `epicenter` is the compiled binary, which is Bun itself under `BUN_BE_BUN=1`. */
export const COMPILED = Bun.main.startsWith('/$bunfs/');

/** How to run this same `epicenter`: the compiled binary alone, or Bun, with the flags it was started with, and this entry. */
function self(): string[] {
	return COMPILED
		? [process.execPath]
		: [process.execPath, ...process.execArgv, Bun.main];
}

/** What a child reports: its answer, and after a run that is not read-only, the app it ran. */
export type Report = {
	answer: unknown;
	wrote?: Wrote & { app: string; folder: string };
};

/** Write `record` to the report file in one rename, so a reader never sees half of it. */
export function writeReport(path: string, record: Report) {
	const temp = `${path}.${randomUUID()}`;
	writeFileSync(temp, `${JSON.stringify(record)}\n`);
	renameSync(temp, path);
}

/**
 * Run `epicenter <args>` as a child and return its report: the one JSON value
 * it answered (for an action, an `Answer`; for a listing, the listing), and
 * for a write run, the app it wrote.
 */
export async function runChild(
	args: string[],
	stdin: 'inherit' | 'ignore',
): Promise<Report> {
	const path = join(tmpdir(), `epicenter-report-${randomUUID()}.json`);
	const child = Bun.spawn([...self(), `${REPORT_FLAG}${path}`, ...args], {
		cwd: epicenterDir(),
		stdio: [stdin, 2, 2],
	});
	const forward = (signal: NodeJS.Signals) => child.kill(signal);
	process.on('SIGINT', forward);
	process.on('SIGTERM', forward);
	let record: Partial<Report> = {};
	try {
		await child.exited;
		try {
			record = JSON.parse(readFileSync(path, 'utf8'));
		} catch {}
	} finally {
		process.off('SIGINT', forward);
		process.off('SIGTERM', forward);
		rmSync(path, { force: true });
	}
	if ('answer' in record) return record as Report;
	const ended =
		child.signalCode === null
			? `exit code ${child.exitCode}`
			: `signal ${child.signalCode}`;
	return {
		answer: {
			threw: { message: `The run ended without an answer (${ended})` },
		},
	};
}

/**
 * Run a call, `epicenter <app> <words> ...`, as a child, then commit the
 * paths it wrote, named for the call (ADR-0850), and return its answer. The
 * command line and both MCP transports run every call this way. A commit
 * that fails changes neither the answer nor the exit code: why, and its next
 * step, go to stderr, and the paths stay pending.
 */
export async function runCall(
	args: string[],
	stdin: 'inherit' | 'ignore',
): Promise<unknown> {
	const { answer, wrote } = await runChild(args, stdin);
	if (wrote) {
		const taken = await snapshot(wrote.app, wrote.folder, { wrote });
		if ('failed' in taken)
			writeErr(
				`${wrote.app}: not yet in history: ${taken.failed.message}\nRun: ${taken.failed.next ?? `epicenter sync ${wrote.app}`}`,
			);
	}
	return answer;
}
