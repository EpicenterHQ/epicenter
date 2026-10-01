import { PersistedAuth } from './auth-types.js';

/** Preloaded identity and one ordered write port. The runtime owns write ordering. */
export type PersistedAuthStorage = {
	initial: PersistedAuth | null;
	set(value: PersistedAuth | null): void | Promise<void>;
};

/** Missing or corrupt session cells are signed out; no OAuth formats are read. */
export function parsePersistedAuth(raw: string | null): PersistedAuth | null {
	if (raw === null) return null;
	try {
		return PersistedAuth.assert(JSON.parse(raw));
	} catch {
		return null;
	}
}

export function serializePersistedAuth(value: PersistedAuth): string {
	return JSON.stringify(PersistedAuth.assert(value));
}

/** Browser storage for the credential and cached principal. Write failures propagate. */
export function createWebStoragePersistedAuthStorage({
	key,
	storage,
}: {
	key: string;
	storage: Storage;
}): PersistedAuthStorage {
	return {
		initial: parsePersistedAuth(storage.getItem(key)),
		set(value) {
			if (value === null) storage.removeItem(key);
			else storage.setItem(key, serializePersistedAuth(value));
		},
	};
}

/** Native boot supplies the initial cell before constructing auth. */
export function createSerializedPersistedAuthStorage({
	initial,
	write,
}: {
	initial: string | null;
	write: (serialized: string | null) => void | Promise<void>;
}): PersistedAuthStorage {
	return {
		initial: parsePersistedAuth(initial),
		set(value) {
			return write(value === null ? null : serializePersistedAuth(value));
		},
	};
}
