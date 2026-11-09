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
 * `{ started }` when the run begins and `{ answer }` when it ends, each by
 * renaming over the file, so the parent reads a whole record or none. A
 * child that dies after starting leaves `started`, and the answer is
 * "unknown": exit 3, with the branch head before and after.
 *
 * The child finishes the run even when its parent dies: nothing it does
 * depends on the parent being there.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { revParse } from './git.ts';
import { exitCodeOf, type RunReport, type Unknown } from './report.ts';

/** The internal flag that makes `epicenter` a child writing its answer to a file; undocumented. */
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

type Started = { folder: string; head: string | null };

/** What a child's command answered: the value `--json` prints, and the exit code derived from it. */
export type ChildAnswer = { answer: unknown; code: number };

/** The exit code an answer implies: 2 did not run, 3 ran and failed or ended unknown, otherwise 0 or the report's. */
export function exitCodeOfAnswer(answer: unknown): number {
	if (typeof answer !== 'object' || answer === null) return 0;
	if ('error' in answer) return 2;
	if ('unknown' in answer) return 3;
	if ('action' in answer && 'refused' in answer)
		return exitCodeOf(answer as RunReport);
	return 0;
}

/** Run `epicenter <args>` as a child and return its answer. */
export async function runChild(
	args: string[],
	{ stdin }: { stdin: 'inherit' | 'ignore' },
): Promise<ChildAnswer> {
	const path = join(tmpdir(), `epicenter-report-${randomUUID()}.json`);
	const child = Bun.spawn([...self(), ...args, `${REPORT_FLAG}${path}`], {
		stdio: [stdin, 2, 2],
	});
	const forward = (signal: NodeJS.Signals) => child.kill(signal);
	process.on('SIGINT', forward);
	process.on('SIGTERM', forward);
	let record: { started?: Started; answer?: unknown } = {};
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
		return { answer: record.answer, code: exitCodeOfAnswer(record.answer) };
	const ended =
		child.signalCode === null
			? `exit code ${child.exitCode}`
			: `signal ${child.signalCode}`;
	const { started } = record;
	const unknown: Unknown = {
		unknown: {
			message: started
				? `The run ended without a report (${ended}); what it committed is between these heads`
				: `epicenter ended before the run started (${ended})`,
			head: {
				before: started?.head ?? null,
				after: started ? await revParse(started.folder, 'HEAD') : null,
			},
		},
	};
	return { answer: unknown, code: 3 };
}
