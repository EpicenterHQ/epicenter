/**
 * A desktop app's own configuration (decision 82): one Markdown note,
 * `settings.md`, in the operating system's configuration directory for the
 * app. It is machine-local and never synced. `folder` is where the app keeps
 * the person's files, chosen on first run and with "Choose folder…"; other
 * machine settings go beside it as more fields. API keys never go here: they
 * stay in the keychain.
 *
 * The desktop shell reads and writes the same note in Rust
 * (`epicenter-standalone`'s `Places`), before the page exists.
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
	const TFields extends { readonly [field: string]: object } = Record<never, never>,
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
 * The roots the standalone shell gave this window (`epicenter-standalone`),
 * set before any of the page's code runs. `config` is the app's
 * configuration directory; `folder` is where it keeps the person's files, or
 * `null` until the person chooses one, in which case `problem` may say why
 * the folder remembered in `settings.md` was not opened. `places` are the
 * two folders offered on first run, beside "Choose folder…".
 */
export type AppFolders = {
	readonly config: string;
	readonly folder: string | null;
	readonly problem: string | null;
	readonly places: { readonly epicenter: string; readonly appData: string };
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
 * Record `folder` as the app's folder in its `settings.md`, keeping every
 * other setting: the page calls this once the shell opened its window on a
 * folder the person chose, so the next launch opens it again.
 */
export async function rememberFolder(
	config: Pick<Client<AppConfig>, 'settings'>,
	folder: string,
): Promise<Result<undefined, ClientError>> {
	const read = await config.settings.get({});
	if (read.error?.name === 'NotFound') {
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
