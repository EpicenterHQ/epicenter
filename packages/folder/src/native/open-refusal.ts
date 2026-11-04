/** How the desktop shell's refusal to open a root reads in the page. */
import { OpenFolderError } from '../errors.js';
import type { RootError } from './bindings.gen.js';

// Tauri also rejects with strings for missing commands or permissions; only
// an object with a name is the shell's own refusal.
function isNamed(refusal: unknown): refusal is { name: string } {
	return typeof refusal === 'object' && refusal !== null && 'name' in refusal;
}

/** Why the shell opened no root, as `openDevice` says it. */
export function rootRefusal(refusal: unknown) {
	if (!isNamed(refusal))
		return OpenFolderError.StorageUnavailable({ cause: refusal });
	const error = refusal as RootError;
	switch (error.name) {
		case 'Disconnected':
			return OpenFolderError.Disconnected({
				folder: error.folder,
				target: error.target,
			});
		case 'Refused':
			return OpenFolderError.Refused({
				folder: error.folder,
				reason: error.reason,
			});
		case 'Unavailable':
			return OpenFolderError.Unreadable({
				folder: error.folder,
				cause: error.message,
			});
		case 'NotNamed':
			return OpenFolderError.StorageUnavailable({
				cause: `the desktop shell named no ${error.root} root for this app`,
			});
		case 'Invalid':
			return OpenFolderError.StorageUnavailable({ cause: error.root });
		case 'NotOpen':
		case 'ShuttingDown':
			return OpenFolderError.StorageUnavailable({ cause: error.name });
		default:
			return OpenFolderError.StorageUnavailable({
				cause: error satisfies never,
			});
	}
}
