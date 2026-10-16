/** Storage owner addresses distinguish accounts, authorities, and case on every filesystem. */
import { expect, test } from 'bun:test';
import { deviceOwnerPath } from './device-owner.js';
import { asPrincipalId } from './principal.js';

test('account identity encodes without case folding or separator collisions', () => {
	const addresses = [
		undefined,
		{ authorityId: 'a', principalId: asPrincipalId('b') },
		{ authorityId: 'a', principalId: asPrincipalId('B') },
		{ authorityId: 'b', principalId: asPrincipalId('b') },
	].map(deviceOwnerPath);
	expect(addresses).toEqual([
		'no-account',
		'accounts/61/62',
		'accounts/61/42',
		'accounts/62/62',
	]);
	expect(new Set(addresses).size).toBe(4);
});

test('empty or malformed account identities are refused', () => {
	expect(() =>
		deviceOwnerPath({ authorityId: '', principalId: asPrincipalId('alice') }),
	).toThrow();
	expect(() =>
		deviceOwnerPath({
			authorityId: '\ud800',
			principalId: asPrincipalId('alice'),
		}),
	).toThrow();
});
