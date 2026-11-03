/** How the desktop shell's refusal to open a folder reads in the page. */
import { OpenDeviceError } from '../errors.js';
import type { DataFolderError, WindowError } from './bindings.gen.js';

// Tauri also rejects with strings for missing commands or permissions; only
// an object with a name is the shell's own refusal.
function isNamed(refusal: unknown): refusal is { name: string } {
	return typeof refusal === 'object' && refusal !== null && 'name' in refusal;
}

/** Why the shell answered no data folder, as `openDataFolder` says it. */
export function dataFolderRefusal(refusal: unknown) {
	if (!isNamed(refusal))
		return OpenDeviceError.StorageUnavailable({ cause: refusal });
	const error = refusal as DataFolderError;
	switch (error.name) {
		case 'Disconnected':
			return OpenDeviceError.Disconnected({
				folder: error.folder,
				target: error.target,
			});
		case 'NoDataFolder':
			return OpenDeviceError.StorageUnavailable({
				cause: 'the desktop shell derived no data folder for this app',
			});
		default:
			return OpenDeviceError.StorageUnavailable({
				cause: error satisfies never,
			});
	}
}

/** Why the shell opened no root, as `openDevice` says it. */
export function deviceRefusal(refusal: unknown, folder: string) {
	if (!isNamed(refusal))
		return OpenDeviceError.StorageUnavailable({ cause: refusal });
	const error = refusal as WindowError;
	switch (error.name) {
		case 'Missing':
			return OpenDeviceError.Missing({ folder });
		case 'NotGranted':
			return OpenDeviceError.NotGranted({ folder });
		case 'Refused':
			return OpenDeviceError.Refused({ folder, reason: error.reason });
		case 'Unavailable':
			return OpenDeviceError.Unreadable({ folder, cause: error.message });
		case 'NotBound':
		case 'ShuttingDown':
			return OpenDeviceError.StorageUnavailable({ cause: error.name });
		default:
			return OpenDeviceError.StorageUnavailable({
				cause: error satisfies never,
			});
	}
}
