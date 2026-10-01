/**
 * Account links preserve the originating server and principal without carrying
 * credentials. A different website identity can detect the mismatch before a
 * purchase, including when principal IDs contain URL delimiters.
 */
import { expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/principal';
import { createAccountManagementUrl } from './account-management.js';

test('account links encode the principal and discard unrelated base URL context', () => {
	const url = createAccountManagementUrl({
		baseURL: 'https://account.example.test/api?unrelated=value#fragment',
		principalId: asPrincipalId('alice&expectedPrincipal=bob#other'),
	});
	expect(url.origin).toBe('https://account.example.test');
	expect(url.pathname).toBe('/dashboard');
	expect([...url.searchParams]).toEqual([
		['expectedPrincipal', 'alice&expectedPrincipal=bob#other'],
	]);
	expect(url.hash).toBe('');
});

test('usage and account management stay on the account server', () => {
	const account = {
		baseURL: 'http://localhost:8787',
		principalId: asPrincipalId('alice'),
	};
	expect(createAccountManagementUrl(account, 'usage').href).toBe(
		'http://localhost:8787/dashboard/usage?expectedPrincipal=alice',
	);
	expect(createAccountManagementUrl(account, 'account').href).toBe(
		'http://localhost:8787/dashboard/account?expectedPrincipal=alice',
	);
});
