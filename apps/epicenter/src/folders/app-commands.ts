/**
 * The Folders window's calls to `epicenter app … --json` (ADR-0556,
 * ADR-0558), through the shell's fixed commands in `installed_apps.rs`.
 *
 * Each command streams the CLI's NDJSON to a `Channel`: `{"progress"}` lines
 * while it works, then one result line. This module hands each progress
 * sentence to the caller and returns the result as `{ data, error }`. Exit 0
 * and exit 1 (an app with no approved commit, whose `pending` carries the
 * review) both return the app; anything else returns the CLI's `{"error"}`
 * message.
 */

import type { InstalledApp, RepositoryApp } from '@epicenter/cli';
import { Channel } from '@tauri-apps/api/core';
import { type CliError, type CliExit, commands } from '../ui/bindings.gen';

export type { InstalledApp, RepositoryApp, Review } from '@epicenter/cli';

/** One line `epicenter app` prints with `--json`. */
type Line = {
	progress?: string;
	error?: string;
	app?: InstalledApp;
	apps?: InstalledApp[] | RepositoryApp[];
	removed?: string;
};

/** How long to wait for a result line that has not arrived when the command returns. */
const RESULT_GRACE_MS = 5000;

type Outcome<T> = { data: T; error: null } | { data: null; error: string };

function cliErrorMessage(error: CliError) {
	return error.name === 'Failed'
		? error.message
		: `This window may not run that command (${error.name}).`;
}

/**
 * Start one command with a fresh `Channel`, pass each progress sentence to
 * `onProgress`, and return the last line that is not progress, or why there
 * is none.
 */
async function run(
	start: (
		onLine: Channel<string>,
	) => Promise<
		{ data: CliExit; error: null } | { data: null; error: CliError }
	>,
	onProgress?: (message: string) => void,
): Promise<Outcome<Line>> {
	let result: Line | undefined;
	let arrived: () => void = () => {};
	const resultArrived = new Promise<void>((resolve) => {
		arrived = resolve;
	});
	const onLine = new Channel<string>((text) => {
		let line: Line;
		try {
			line = JSON.parse(text) as Line;
		} catch {
			return;
		}
		if (line.progress !== undefined) onProgress?.(line.progress);
		else {
			result = line;
			arrived();
		}
	});
	try {
		const { data: exit, error } = await start(onLine);
		if (error !== null) return { data: null, error: cliErrorMessage(error) };
		// A channel's messages may land after the command returns; the CLI
		// prints its result line before it exits, so it is on its way.
		if (result === undefined)
			await Promise.race([
				resultArrived,
				new Promise((resolve) => setTimeout(resolve, RESULT_GRACE_MS)),
			]);
		if (result?.error !== undefined) return { data: null, error: result.error };
		if ((exit.code === 0 || exit.code === 1) && result !== undefined)
			return { data: result, error: null };
		return {
			data: null,
			error:
				exit.stderr.trim() ||
				`epicenter exited with ${exit.code} and no result`,
		};
	} catch (cause) {
		return {
			data: null,
			error: cause instanceof Error ? cause.message : String(cause),
		};
	}
}

/** The result's `app`, or why there is none. */
function app(outcome: Outcome<Line>): Outcome<InstalledApp> {
	if (outcome.error !== null) return outcome;
	return outcome.data.app === undefined
		? { data: null, error: 'epicenter printed no app' }
		: { data: outcome.data.app, error: null };
}

/** Every installed app, with whether it can run and any commit waiting for approval. */
export async function listInstalledApps(): Promise<Outcome<InstalledApp[]>> {
	const outcome = await run((onLine) => commands.listInstalledApps(onLine));
	if (outcome.error !== null) return outcome;
	return { data: (outcome.data.apps ?? []) as InstalledApp[], error: null };
}

/** The apps in the repository at `source`, each with the folder to install it from. */
export async function listRepositoryApps(
	source: string,
): Promise<Outcome<RepositoryApp[]>> {
	const outcome = await run((onLine) =>
		commands.listRepositoryApps(source, onLine),
	);
	if (outcome.error !== null) return outcome;
	return { data: (outcome.data.apps ?? []) as RepositoryApp[], error: null };
}

/** Clone the app at `folder` of the repository at `source`; nothing is approved yet. */
export async function installApp(
	source: string,
	folder: string,
	onProgress?: (message: string) => void,
) {
	return app(
		await run(
			(onLine) => commands.installApp(source, folder, onLine),
			onProgress,
		),
	);
}

/** Approve `commit` of app `id`, the commit the person was shown, and build it. */
export async function approveApp(
	id: string,
	commit: string,
	onProgress?: (message: string) => void,
) {
	return app(
		await run((onLine) => commands.approveApp(id, commit, onLine), onProgress),
	);
}

/** Fetch app `id`'s default branch; a fetched commit waits for approval in `pending`. */
export async function updateApp(
	id: string,
	onProgress?: (message: string) => void,
) {
	return app(await run((onLine) => commands.updateApp(id, onLine), onProgress));
}
