/** How the desktop shell's refusal to open a folder reads in the page. */
import { OpenDeviceError } from '../errors.js';
import type { WindowError } from './bindings.gen.js';

/** Why the shell opened no root, as `openDevice` says it. */
export function deviceRefusal(refusal: unknown, folder: string) {
	// Tauri also rejects with strings for missing commands or permissions;
	// only an object with a name is the shell's own refusal.
	if (typeof refusal !== 'object' || refusal === null || !('name' in refusal))
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
