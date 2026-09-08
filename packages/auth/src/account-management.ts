import type { Account } from './auth-contract.js';

/**
 * Build a hosted account website link for the account an app is using.
 * The expected principal prevents a different website account from continuing
 * the targeted flow. It is navigation context, never authentication.
 */
export function createAccountManagementUrl(
	account: Pick<Account, 'baseURL' | 'principalId'>,
	section: 'credits' | 'usage' | 'account' = 'credits',
) {
	const path = {
		credits: '/dashboard',
		usage: '/dashboard/usage',
		account: '/dashboard/account',
	}[section];
	const url = new URL(path, account.baseURL);
	url.searchParams.set('expectedPrincipal', account.principalId);
	return url;
}
