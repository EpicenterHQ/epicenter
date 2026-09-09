import type { AccountIdentity } from '@epicenter/principal';

/** Preserve component boundaries, including local versus authenticated scope. */
export function secretScopeKey(
	appId: string,
	account: AccountIdentity | null,
): string {
	return JSON.stringify([
		appId,
		account === null ? null : [account.authorityId, account.principalId],
	]);
}
