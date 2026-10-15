/**
 * `epicenter install-command`: link the binary Epicenter bundles onto `PATH`
 * as `epicenter`, so a terminal, an agent, and the app run one version
 * (ADR-0556). Settings runs it with `--json`; a person may run it by the
 * bundled binary's full path.
 *
 * It only ever makes or replaces a symbolic link. A regular file at the
 * target is someone else's and is refused. When the directory is not
 * writable, a person at a terminal is asked before `sudo` runs; any other
 * caller is told the command to run and exits 1.
 */

import {
	accessSync,
	constants,
	lstatSync,
	readlinkSync,
	realpathSync,
	renameSync,
	symlinkSync,
	unlinkSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { EXIT, fail, writeErr, writeJson, writeOut } from './output.ts';

/** Where the command goes on macOS and Linux. */
export const COMMAND_PATH = '/usr/local/bin/epicenter';

export type LinkPlan =
	| { action: 'unchanged'; binary: string; target: string }
	| {
			action: 'link';
			binary: string;
			target: string;
			/** What the link at `target` points at now, when it is replaced. */
			replacing?: string;
			/** The directory is missing or not writable by this user. */
			needsAdmin: boolean;
	  }
	| { action: 'refused'; binary: string; target: string; reason: string };

function writable(directory: string) {
	try {
		accessSync(directory, constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

/** What linking `binary` at `target` would do. Reads, and changes nothing. */
export function planLink(binary: string, target: string): LinkPlan {
	const needsAdmin = !writable(dirname(target));
	const existing = lstatSync(target, { throwIfNoEntry: false });
	if (existing === undefined)
		return { action: 'link', binary, target, needsAdmin };
	if (!existing.isSymbolicLink())
		return {
			action: 'refused',
			binary,
			target,
			reason: `${target} exists and is not a link; remove it to install the epicenter command`,
		};
	const current = readlinkSync(target);
	if (resolve(dirname(target), current) === binary)
		return { action: 'unchanged', binary, target };
	return { action: 'link', binary, target, replacing: current, needsAdmin };
}

/** Make or replace the link in one rename, so `target` is never missing. */
export function applyLink({
	binary,
	target,
}: {
	binary: string;
	target: string;
}) {
	const staged = `${target}.${process.pid}.tmp`;
	try {
		symlinkSync(binary, staged);
		renameSync(staged, target);
	} catch (error) {
		try {
			unlinkSync(staged);
		} catch {}
		throw error;
	}
}

/** The `sudo` command a person runs when the directory needs an administrator. */
export function adminCommand({
	binary,
	target,
}: {
	binary: string;
	target: string;
}) {
	const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
	return `sudo mkdir -p ${quote(dirname(target))} && sudo ln -sfn ${quote(binary)} ${quote(target)}`;
}

/**
 * The compiled binary running this command, or `undefined` when it runs
 * from source under `bun`, which must not be linked as `epicenter`.
 */
export function compiledBinary() {
	const compiled =
		Bun.main.startsWith('/$bunfs/') || Bun.main.startsWith('B:/~BUN/');
	return compiled ? realpathSync(process.execPath) : undefined;
}

async function ask(question: string) {
	writeErr(question);
	for await (const line of console) return /^y(es)?$/i.test(line.trim());
	return false;
}

export async function installCommand({
	json,
	dryRun,
	binary = compiledBinary(),
	target = COMMAND_PATH,
	interactive = !json && process.stdin.isTTY === true,
}: {
	json: boolean;
	dryRun: boolean;
	binary?: string;
	target?: string;
	interactive?: boolean;
}) {
	if (process.platform === 'win32')
		return fail('install-command is not built for Windows yet', json);
	if (binary === undefined)
		return fail(
			`install-command links the compiled epicenter binary, and this one runs from source (${Bun.main}); run it from the binary Epicenter bundles`,
			json,
		);
	const plan = planLink(binary, target);
	const report = (linked: boolean, extra: object = {}) => {
		if (json) writeJson({ ...plan, dryRun, linked, ...extra });
	};
	if (plan.action === 'refused') {
		report(false);
		if (!json) writeErr(plan.reason);
		return EXIT.finding;
	}
	if (plan.action === 'unchanged') {
		report(false);
		if (!json) writeOut(`${target} already runs ${binary}`);
		return EXIT.ok;
	}
	const command = adminCommand(plan);
	if (dryRun) {
		report(false, plan.needsAdmin ? { command } : {});
		if (!json)
			writeOut(
				plan.needsAdmin
					? `would run: ${command}`
					: `would link ${target} -> ${binary}`,
			);
		return EXIT.ok;
	}
	if (!plan.needsAdmin) {
		applyLink(plan);
		report(true);
		if (!json) writeOut(`linked ${target} -> ${binary}`);
		return EXIT.ok;
	}
	if (
		!interactive ||
		!(await ask(
			`${dirname(target)} needs an administrator. Run \`${command}\`? [y/N]`,
		))
	) {
		report(false, { command });
		if (!json) writeErr(`Not linked. To link it, run: ${command}`);
		return EXIT.finding;
	}
	const sudo = Bun.spawn(['sh', '-c', command], {
		stdin: 'inherit',
		stdout: 'inherit',
		stderr: 'inherit',
	});
	if ((await sudo.exited) !== 0) {
		writeErr(`Not linked: ${command} failed`);
		return EXIT.finding;
	}
	writeOut(`linked ${target} -> ${binary}`);
	return EXIT.ok;
}
