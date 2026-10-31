/**
 * What every standalone desktop app's settings contract shares (decisions 86
 * to 89): `settings.md`, whose `folder` is the data folder the person chose
 * with "Choose data folder…", absent for the default `~/Epicenter/<App>`.
 *
 * An app's settings are flat fixed-path notes, one per concern
 * (`settings.md`, `shortcuts.md`, …), written as an ordinary
 * `defineContract`. The same notes may sit in both roots: the data folder
 * holds the synced values, the AppData root this computer's sparse
 * overrides, and a reader resolves each note with a shallow spread,
 * `{ ...defaults, ...data, ...appData }`. `folder` is the one key that
 * belongs only to the AppData root. API keys never go in a settings note:
 * they stay in the keychain.
 *
 * Only the page reads and writes these notes, through the contract's
 * client; the desktop shell never parses them.
 *
 * ```ts
 * const captureSettings = defineContract({
 * 	name: 'capture-settings',
 * 	collections: {
 * 		settings: { path: 'settings.md', fields: { folder: { type: 'string' } } },
 * 	},
 * });
 * const appData = await openAppData(captureSettings);
 * ```
 */
import type {
	ClientError,
	Contract,
	NoteClient,
} from '@epicenter/definition/contract';
import { Err, Ok, type Result } from 'wellcrafted/result';

/** `settings.md` with `folder` among its keys, as every app's settings contract declares it. */
type FolderNote = {
	readonly path: 'settings.md';
	readonly fields: { readonly folder: { readonly type: 'string' } };
};

/**
 * An app's settings contract: any contract whose `settings` collection is
 * `settings.md` with an optional string `folder`, beside whatever other
 * keys and notes the app keeps.
 */
export type SettingsContract = Contract & {
	readonly collections: { readonly settings: FolderNote };
};

/** What reads and writes `folder`: the `settings` note of any app's settings client. */
export type FolderSettings = { readonly settings: NoteClient<FolderNote> };

/**
 * Record `folder` as the app's data folder in its `settings.md`, keeping
 * every other setting, or forget it for `undefined` (the default folder):
 * "Choose folder…", "Allow access" and "Use the default folder" write it,
 * then open the roots again.
 */
export async function rememberFolder(
	appData: FolderSettings,
	folder: string | undefined,
): Promise<Result<undefined, ClientError>> {
	const read = await appData.settings.get({});
	if (read.error?.name === 'NotFound') {
		if (folder === undefined) return Ok(undefined);
		const made = await appData.settings.create({ folder });
		return made.error === null ? Ok(undefined) : Err(made.error);
	}
	if (read.error !== null) return Err(read.error);
	if (read.data.folder === folder) return Ok(undefined);
	const updated = await appData.settings.update(
		{},
		{ folder },
		{ over: read.data.version },
	);
	return updated.error === null ? Ok(undefined) : Err(updated.error);
}
