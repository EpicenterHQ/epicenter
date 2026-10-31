/**
 * A desktop app's own configuration (decisions 88 and 89): `settings.md` at
 * the top of the app's AppData root, machine-local and never synced. `folder`
 * is the data folder the person chose with "Choose data folder…", absent for
 * the default `~/Epicenter/<App>`; other machine settings go beside it as
 * more fields. API keys never go here: they stay in the keychain.
 *
 * Only the page reads and writes the note, through this contract's client;
 * the desktop shell never parses it.
 */
import {
	type Client,
	type ClientError,
	defineContract,
} from '@epicenter/definition/contract';
import { Err, Ok, type Result } from 'wellcrafted/result';

/**
 * A desktop app's `settings.md` contract with its own machine settings beside
 * `folder` (decision 82): whatever belongs to this computer and never to the
 * person's synced files, such as Vocab's connected endpoints. Every field is
 * optional; `folder` is always there.
 *
 * ```ts
 * const vocabConfig = defineAppConfig({
 * 	endpoints: { type: 'array', items: { type: 'object' } },
 * });
 * ```
 */
export function defineAppConfig<
	const TFields extends { readonly [field: string]: object } = Record<
		never,
		never
	>,
>(fields: TFields = {} as TFields) {
	return defineContract({
		name: 'app-config',
		description:
			"A desktop app's machine-local settings, never synced: `folder` is where it keeps the person's files.",
		collections: {
			settings: {
				path: 'settings.md',
				fields: { ...fields, folder: { type: 'string' } as const },
			},
		},
	});
}

/** The settings every desktop app has: only `folder`. */
export const appConfig = defineAppConfig();

export type AppConfig = typeof appConfig;

/**
 * What the standalone shell told this window (`epicenter-standalone`) before
 * any of the page's code ran: `config`, the app's AppData root, the one root
 * the window starts with; and `default`, the data folder opened when
 * `settings.md` names none (`~/Epicenter/<App>`).
 */
export type AppFolders = {
	readonly config: string;
	readonly default: string;
};

declare global {
	interface Window {
		__EPICENTER_APP_FOLDERS__?: AppFolders;
	}
}

/** This window's roots, or `null` outside a standalone app's window. */
export function appFolders(): AppFolders | null {
	if (typeof window === 'undefined') return null;
	return window.__EPICENTER_APP_FOLDERS__ ?? null;
}

/**
 * Record `folder` as the app's data folder in its `settings.md`, keeping
 * every other setting, or forget it for `undefined` (the default folder):
 * the page calls this once the shell opened a folder the person chose, so
 * the next launch opens it again.
 */
export async function rememberFolder(
	config: Pick<Client<AppConfig>, 'settings'>,
	folder: string | undefined,
): Promise<Result<undefined, ClientError>> {
	const read = await config.settings.get({});
	if (read.error?.name === 'NotFound') {
		if (folder === undefined) return Ok(undefined);
		const made = await config.settings.create({ folder });
		return made.error === null ? Ok(undefined) : Err(made.error);
	}
	if (read.error !== null) return Err(read.error);
	if (read.data.folder === folder) return Ok(undefined);
	const updated = await config.settings.update(
		{},
		{ folder },
		{ over: read.data.version },
	);
	return updated.error === null ? Ok(undefined) : Err(updated.error);
}
