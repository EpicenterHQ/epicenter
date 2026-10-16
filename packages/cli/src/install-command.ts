/**
 * `epicenter install-command`: keep one stable path to the binary Epicenter
 * bundles, and link it onto `PATH` as `epicenter`, so a terminal, an agent,
 * Git, and the app run one version (ADR-0556, ADR-0566).
 *
 * ```txt
 * <dataDir>/bin/epicenter    -> the bundled binary         remade at every launch, never with sudo
 * /usr/local/bin/epicenter   -> <dataDir>/bin/epicenter    ~/.local/bin/epicenter on Linux
 * ```
 *
 * Every Git configuration Epicenter writes (the credential helper and
 * `merge.epicenter.driver`) runs `<dataDir>/bin/epicenter` (`gitCommand`),
 * so moving the app breaks nothing past its next launch, which remakes the
 * link. The app runs `install-command --user-only --json` at launch, and
 * `auth login` and `merge-driver <dir>` remake the link before they write
 * configuration. A Linux AppImage runs from a mount that disappears when it
 * quits, so there the binary is copied rather than linked. Windows writes
 * the installed `.exe` path, since a link there needs an administrator.
 *
 * The `PATH` link only ever makes or replaces a symbolic link. A regular
 * file at the target is someone else's and is refused. When the directory
 * is not writable, a person at a terminal is asked before `sudo` runs; any
 * other caller is told the command to run and exits 1.
 */

import {
	accessSync,
	chmodSync,
	constants,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readlinkSync,
	realpathSync,
	renameSync,
	statSync,
	symlinkSync,
	unlinkSync,
	utimesSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { resolveAppPaths } from './app-paths.ts';
import { EXIT, fail, writeErr, writeJson, writeOut } from './output.ts';

type Environment = Readonly<Record<string, string | undefined>>;

/** Where the `PATH` link goes: `/usr/local/bin`, or `~/.local/bin` on Linux, which needs no `sudo`. */
export function pathLinkTarget(home = homedir()) {
	return process.platform === 'linux'
		? join(home, '.local', 'bin', 'epicenter')
		: '/usr/local/bin/epicenter';
}

/**
 * The compiled binary running this command, by its real path, or
 * `undefined` when it runs from source under `bun`, which must not be
 * linked as `epicenter`. Run through a link, the path without resolving
 * would point the per-user link at itself.
 */
export function compiledBinary() {
	const compiled =
		Bun.main.startsWith('/$bunfs/') || /^[A-Z]:[\\/]~BUN[\\/]/i.test(Bun.main);
	return compiled ? realpathSync(process.execPath) : undefined;
}

// ---------------------------------------------------------------------------
// The per-user link: <dataDir>/bin/epicenter
// ---------------------------------------------------------------------------

export type CommandLinkPlan = {
	/**
	 * `link` and `copy` make or replace it. `translocated` leaves it alone:
	 * macOS runs a quarantined app from a read-only copy that disappears when
	 * it quits, and a link to that copy would dangle.
	 */
	action: 'unchanged' | 'link' | 'copy' | 'translocated';
	binary: string;
	link: string;
};

/** A path inside macOS's App Translocation copy of an app. */
export function isTranslocated(binary: string) {
	return /^\/private\/var\/folders\/.+\/AppTranslocation\//.test(binary);
}

/** What refreshing `link` to run `binary` would do. Reads, and changes nothing. */
export function planCommandLink(
	binary: string,
	link: string,
	env: Environment = process.env,
): CommandLinkPlan {
	const plan = (action: CommandLinkPlan['action']) => ({
		action,
		binary,
		link,
	});
	// A terminal running an AppImage's copy is running the link itself.
	if (binary === link) return plan('unchanged');
	if (isTranslocated(binary)) return plan('translocated');
	const existing = lstatSync(link, { throwIfNoEntry: false });
	if (process.platform === 'linux' && env.APPIMAGE) {
		const source = statSync(binary);
		const current =
			existing?.isFile() === true &&
			existing.size === source.size &&
			existing.mtimeMs === source.mtimeMs;
		return plan(current ? 'unchanged' : 'copy');
	}
	const current =
		existing?.isSymbolicLink() === true && readlinkSync(link) === binary;
	return plan(current ? 'unchanged' : 'link');
}

/** Make or replace the per-user link in one rename, so it is never missing. */
export function applyCommandLink({ action, binary, link }: CommandLinkPlan) {
	if (action === 'link') return applyLink({ binary, target: link });
	if (action !== 'copy') return;
	mkdirSync(dirname(link), { recursive: true });
	const staged = `${link}.${process.pid}.tmp`;
	try {
		copyFileSync(binary, staged);
		chmodSync(staged, 0o755);
		// The copy keeps the source's times, which is how a later launch knows it is current.
		const { atime, mtime } = statSync(binary);
		utimesSync(staged, atime, mtime);
		renameSync(staged, link);
	} catch (error) {
		try {
			unlinkSync(staged);
		} catch {}
		throw error;
	}
}

const TRANSLOCATED =
	'macOS is running Epicenter from a temporary copy (App Translocation), so the epicenter command was not pointed at it. Move Epicenter to Applications and open it again.';

/**
 * The command every Git configuration Epicenter writes runs: the per-user
 * link, first pointed at the binary running now. On Windows it is the
 * installed `.exe`; run from source, it is `bun` and the entry, which only a
 * development build writes.
 *
 * A link that cannot be made is said on stderr, and the configuration names
 * the link anyway, which the app's next launch makes.
 */
export function gitCommand({
	binary = compiledBinary(),
	link = resolveAppPaths().commandLink,
	env = process.env,
}: {
	binary?: string;
	link?: string;
	env?: Environment;
} = {}): string[] {
	if (binary === undefined) return [process.execPath, Bun.main];
	if (process.platform === 'win32') return [binary];
	try {
		const plan = planCommandLink(binary, link, env);
		if (plan.action === 'translocated') writeErr(TRANSLOCATED);
		applyCommandLink(plan);
	} catch (error) {
		writeErr(
			`${link} could not be pointed at ${binary}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return [link];
}

// ---------------------------------------------------------------------------
// The PATH link
// ---------------------------------------------------------------------------

export type LinkPlan =
	| { action: 'unchanged'; binary: string; target: string }
	| {
			action: 'link';
			binary: string;
			target: string;
			/** What the link at `target` points at now, when it is replaced. */
			replacing?: string;
			/** The directory cannot be written, or made, by this user. */
			needsAdmin: boolean;
	  }
	| { action: 'refused'; binary: string; target: string; reason: string };

/** Whether this user can write `directory`, or make it under its nearest existing parent. */
function writable(directory: string): boolean {
	if (!existsSync(directory)) {
		const parent = dirname(directory);
		return parent !== directory && writable(parent);
	}
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

/** Make or replace a link in one rename, so `target` is never missing. */
export function applyLink({
	binary,
	target,
}: {
	binary: string;
	target: string;
}) {
	mkdirSync(dirname(target), { recursive: true });
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

async function ask(question: string) {
	writeErr(question);
	for await (const line of console) return /^y(es)?$/i.test(line.trim());
	return false;
}

export async function installCommand({
	json,
	dryRun,
	userOnly = false,
	binary = compiledBinary(),
	link = resolveAppPaths().commandLink,
	target = pathLinkTarget(),
	env = process.env,
	interactive = !json && process.stdin.isTTY === true,
}: {
	json: boolean;
	dryRun: boolean;
	/** Remake only the per-user link, as the app does at every launch. */
	userOnly?: boolean;
	binary?: string;
	link?: string;
	target?: string;
	env?: Environment;
	interactive?: boolean;
}) {
	if (process.platform === 'win32')
		return fail('install-command is not built for Windows yet', json);
	if (binary === undefined)
		return fail(
			`install-command links the compiled epicenter binary, and this one runs from source (${Bun.main}); run it from the binary Epicenter bundles`,
			json,
		);

	const commandLink = planCommandLink(binary, link, env);
	if (!dryRun) applyCommandLink(commandLink);
	if (!json) {
		if (commandLink.action === 'translocated') writeErr(TRANSLOCATED);
		else
			writeOut(
				{
					unchanged: `${link} already runs ${binary}`,
					link: `${dryRun ? 'would link' : 'linked'} ${link} -> ${binary}`,
					copy: `${dryRun ? 'would copy' : 'copied'} ${binary} to ${link}`,
				}[commandLink.action],
			);
	}
	// Translocated, the per-user link is left as it was: a finding to act on.
	const done = commandLink.action === 'translocated' ? EXIT.finding : EXIT.ok;
	if (userOnly) {
		if (json) writeJson({ commandLink, dryRun });
		return done;
	}

	const path = planLink(link, target);
	const report = (linked: boolean, extra: object = {}) => {
		if (json)
			writeJson({ commandLink, path: { ...path, linked, ...extra }, dryRun });
	};
	if (path.action === 'refused') {
		report(false);
		if (!json) writeErr(path.reason);
		return EXIT.finding;
	}
	if (path.action === 'unchanged') {
		report(false);
		if (!json) writeOut(`${target} already runs ${link}`);
		return done;
	}
	const command = adminCommand(path);
	if (dryRun) {
		report(false, path.needsAdmin ? { command } : {});
		if (!json)
			writeOut(
				path.needsAdmin
					? `would run: ${command}`
					: `would link ${target} -> ${link}`,
			);
		return done;
	}
	if (!path.needsAdmin) {
		applyLink(path);
		report(true);
		if (!json) writeOut(`linked ${target} -> ${link}`);
		return done;
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
	writeOut(`linked ${target} -> ${link}`);
	return done;
}
