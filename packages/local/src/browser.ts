/**
 * `@epicenter/local` in a web build (the `default` leaf): each file is one
 * entry of this browser's `localStorage` for the site, under
 * `epicenter.local/<name>`. Each app is its own site, so the key names no
 * app. A write checks the version and sets the entry in one synchronous
 * step, so two tabs never overwrite each other unseen; another tab's write
 * arrives as a `storage` event.
 */
import { Ok } from 'wellcrafted/result';
import {
	createListeners,
	LocalFileError,
	type OpenLocalFile,
} from './local-file.js';

export {
	type LocalFile,
	LocalFileError,
	type LocalText,
} from './local-file.js';

const PREFIX = 'epicenter.local/';

const own = createListeners();

/**
 * The version of `text`: a 64-bit FNV-1a hash in hex, computed at once so
 * a write's check and its change are one step.
 */
function versionOf(text: string): string {
	let hash = 0xcbf29ce484222325n;
	for (let index = 0; index < text.length; index++) {
		hash ^= BigInt(text.charCodeAt(index));
		hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
	}
	return hash.toString(16).padStart(16, '0');
}

/** The file `name` in this browser's storage for the site. */
export const localFile: OpenLocalFile = (name) => {
	const key = PREFIX + name;
	return {
		async read() {
			try {
				const text = localStorage.getItem(key);
				return Ok(text === null ? null : { text, version: versionOf(text) });
			} catch (cause) {
				return LocalFileError.Unavailable({ cause });
			}
		},
		async write(text, over) {
			try {
				const current = localStorage.getItem(key);
				const holds =
					over === 'absent'
						? current === null
						: current !== null && versionOf(current) === over;
				if (!holds) return Ok('stale');
				if (text === null) localStorage.removeItem(key);
				else localStorage.setItem(key, text);
			} catch (cause) {
				return LocalFileError.Unavailable({ cause });
			}
			own.emit(name);
			return Ok({ version: text === null ? 'absent' : versionOf(text) });
		},
		subscribe(listener) {
			const stopOwn = own.add(name, listener);
			if (typeof window === 'undefined') return stopOwn;
			const changed = (event: StorageEvent) => {
				if (event.key === key || event.key === null) listener();
			};
			window.addEventListener('storage', changed);
			return () => {
				stopOwn();
				window.removeEventListener('storage', changed);
			};
		},
	};
};
