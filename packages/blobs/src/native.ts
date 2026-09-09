import type { AccountIdentity } from '@epicenter/principal';

/** Address of a dataset in the desktop blob protocol, never a filesystem path. */
export type BlobDestination = {
	appId: string;
	scope:
		| { kind: 'local' }
		| { kind: 'account'; authorityId: string; principalId: string };
};

/** Capture native addressing at the IPC boundary. */
export function blobDestination(
	appId: string,
	account: AccountIdentity | null,
): BlobDestination {
	return {
		appId,
		scope:
			account === null
				? { kind: 'local' }
				: {
						kind: 'account',
						authorityId: account.authorityId,
						principalId: account.principalId,
					},
	};
}
