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
 * whole answer or none. A child that ends without one answers that it threw
 * (exit 1), naming its exit code or signal; whatever it wrote stays on disk.
 *
 * The child finishes the run even when its parent dies: nothing it does
 * depends on the parent being there.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The internal flag that makes `epicenter` a child writing its answer to a file; undocumented, and read only as the first argument, so an action's own input can never be taken for it. */
export const REPORT_FLAG = '--report=';

/** How to run this same `epicenter`: the compiled binary alone, or Bun, with the flags it was started with, and this entry. */
function self(): string[] {
	return Bun.main.startsWith('/$bunfs/')
		? [process.execPath]
		: [process.execPath, ...process.execArgv, Bun.main];
}

/** Write `record` to the report file in one rename, so a reader never sees half of it. */
export function writeReport(path: string, record: object) {
	const temp = `${path}.${randomUUID()}`;
	writeFileSync(temp, `${JSON.stringify(record)}\n`);
	renameSync(temp, path);
}

/**
 * Run `epicenter <args>` as a child and return the one JSON value it
 * answered: for an action, an `Answer`; for a listing, the listing.
 */
export async function runChild(
	args: string[],
	{ stdin }: { stdin: 'inherit' | 'ignore' },
): Promise<unknown> {
	return (await runChildRecord(args, { stdin })).answer;
}

/** Run a child and retain private run metadata alongside its public answer. */
export async function runChildRecord(
	args: string[],
	{ stdin }: { stdin: 'inherit' | 'ignore' },
): Promise<{ answer: unknown; firstPositional?: unknown; folder?: string }> {
	const path = join(tmpdir(), `epicenter-report-${randomUUID()}.json`);
	const child = Bun.spawn([...self(), `${REPORT_FLAG}${path}`, ...args], {
		stdio: [stdin, 2, 2],
	});
	const forward = (signal: NodeJS.Signals) => child.kill(signal);
	process.on('SIGINT', forward);
	process.on('SIGTERM', forward);
	let record: { answer?: unknown; firstPositional?: unknown; folder?: string } =
		{};
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
	if ('answer' in record)
		return {
			answer: record.answer,
			firstPositional: record.firstPositional,
			folder: record.folder,
		};
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
