/**
 * `epicenter install-command`: point one link, `~/.local/bin/epicenter`, at
 * the binary Epicenter bundles, so a terminal, an agent, Git, and the app run
 * one version (ADR-0556, ADR-0566, ADR-0567).
 *
 * ```txt
 * ~/.local/bin/epicenter   -> /Applications/Epicenter.app/Contents/MacOS/epicenter-cli
 * ```
 *
 * The app runs `install-command --json` at every launch, so moving the app
 * breaks nothing past its next launch. Every Git configuration Epicenter
 * writes (the credential helper and `merge.epicenter.driver`) names the link
 * by its absolute path (`gitCommand`), because a Git client started from the
 * Finder gets launchd's `PATH`. A terminal reaches it on `PATH` once a person
 * adds `~/.local/bin` there.
 *
 * The command only ever makes or replaces a symbolic link. A regular file at
 * the link's path is someone else's and is refused. No step needs `sudo`.
 */

import {
	lstatSync,
	mkdirSync,
	readlinkSync,
	realpathSync,
	renameSync,
	symlinkSync,
	unlinkSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { resolveAppPaths } from './app-paths.ts';
import { EXIT, fail, writeErr, writeJson, writeOut } from './output.ts';

/**
 * The compiled binary running this command, by its real path, or
 * `undefined` when it runs from source under `bun`, which must not be
 * linked as `epicenter`. Run through the link, the path without resolving
 * would point the link at itself.
 */
export function compiledBinary() {
	return Bun.main.startsWith('/$bunfs/')
		? realpathSync(process.execPath)
		: undefined;
}

export type CommandLinkPlan = {
	/**
	 * `link` makes or replaces it. `translocated` leaves it alone: macOS runs
	 * a quarantined app from a read-only copy that disappears when it quits,
	 * and a link to that copy would dangle. `refused` leaves a regular file
	 * that is not Epicenter's.
	 */
	action: 'unchanged' | 'link' | 'translocated' | 'refused';
	binary: string;
	link: string;
};

/** A path inside macOS's App Translocation copy of an app. */
export function isTranslocated(binary: string) {
	return /^\/private\/var\/folders\/.+\/AppTranslocation\//.test(binary);
}

/** What pointing `link` at `binary` would do. Reads, and changes nothing. */
export function planCommandLink(binary: string, link: string): CommandLinkPlan {
	const plan = (action: CommandLinkPlan['action']) => ({
		action,
		binary,
		link,
	});
	// A terminal running the link itself.
	if (binary === link) return plan('unchanged');
	if (isTranslocated(binary)) return plan('translocated');
	const existing = lstatSync(link, { throwIfNoEntry: false });
	if (existing === undefined) return plan('link');
	if (!existing.isSymbolicLink()) return plan('refused');
	return plan(readlinkSync(link) === binary ? 'unchanged' : 'link');
}

/** Make or replace the link in one rename, so it is never missing. */
export function applyCommandLink({ action, binary, link }: CommandLinkPlan) {
	if (action !== 'link') return;
	mkdirSync(dirname(link), { recursive: true });
	const staged = `${link}.${process.pid}.tmp`;
	try {
		symlinkSync(binary, staged);
		renameSync(staged, link);
	} catch (error) {
		try {
			unlinkSync(staged);
		} catch {}
		throw error;
	}
}

/**
 * The command every Git configuration Epicenter writes runs: the link, by
 * its absolute path. It is the same path whether this process runs from the
 * bundle, the link, or source, so a development run never writes a checkout
 * into the global configuration; the app's launch keeps the link pointed at
 * the bundle.
 */
export function gitCommand(link = resolveAppPaths().commandLink): string[] {
	return [link];
}

export async function installCommand({
	json,
	binary = compiledBinary(),
	link = resolveAppPaths().commandLink,
}: {
	json: boolean;
	binary?: string;
	link?: string;
}) {
	if (binary === undefined)
		return fail(
			`install-command links the compiled epicenter binary, and this one runs from source (${Bun.main}); run it from the binary Epicenter bundles`,
			json,
		);
	const plan = planCommandLink(binary, link);
	applyCommandLink(plan);
	if (json) writeJson({ commandLink: plan });
	switch (plan.action) {
		case 'unchanged':
			if (!json) writeOut(`${link} already runs ${binary}`);
			return EXIT.ok;
		case 'link':
			if (!json) writeOut(`linked ${link} -> ${binary}`);
			return EXIT.ok;
		case 'translocated':
			writeErr(
				'macOS is running Epicenter from a temporary copy (App Translocation), so the epicenter command was not pointed at it. Move Epicenter to Applications and open it again.',
			);
			return EXIT.finding;
		case 'refused':
			writeErr(
				`${link} exists and is not a link; remove it to install the epicenter command`,
			);
			return EXIT.finding;
	}
}
