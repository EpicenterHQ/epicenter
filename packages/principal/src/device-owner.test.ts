/** Storage owner addresses distinguish accounts, authorities, and case on every filesystem. */
import { expect, test } from 'bun:test';
import { deviceOwnerPath, isDeviceOwnerPath } from './device-owner.js';
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
	for (const address of addresses)
		expect(isDeviceOwnerPath(address)).toBe(true);
});

test('untrusted owner paths cannot escape or alias a namespace', () => {
	for (const path of [
		'../no-account',
		'accounts/../62',
		'/no-account',
		'accounts/6/62',
		'accounts/AA/62',
		'no-account/',
	])
		expect(isDeviceOwnerPath(path)).toBe(false);
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
