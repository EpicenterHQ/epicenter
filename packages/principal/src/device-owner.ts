import type { AccountIdentity } from './principal.js';

/** Validate a serialized owner before using it as a relative storage path. */
export function isDeviceOwnerPath(value: string): boolean {
	return (
		value === 'no-account' ||
		/^accounts\/(?:[0-9a-f]{2})+\/(?:[0-9a-f]{2})+$/.test(value)
	);
}

/** Canonical local-storage owner. Hex preserves identity on case-insensitive filesystems. */
export function deviceOwnerPath(account?: AccountIdentity): string {
	if (account === undefined) return 'no-account';
	const encode = (value: string) => {
		if (
			typeof value !== 'string' ||
			value.length === 0 ||
			!value.isWellFormed() ||
			/[\p{Cc}]/u.test(value)
		)
			throw new TypeError('Invalid device account identity.');
		return Array.from(new TextEncoder().encode(value), (byte) =>
			byte.toString(16).padStart(2, '0'),
		).join('');
	};
	return `accounts/${encode(account.authorityId)}/${encode(account.principalId)}`;
}
