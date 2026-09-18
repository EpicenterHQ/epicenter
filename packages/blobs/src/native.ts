/** Native wire destination: application and credential-free storage owner. */
import type { AccountIdentity } from '@epicenter/principal';
export type BlobDestination = {
	appId: string;
	account: AccountIdentity | null;
};

export function blobDestination(
	appId: string,
	account?: AccountIdentity,
): BlobDestination {
	return { appId, account: account ?? null };
}
