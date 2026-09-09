/**
 * Credential refusal preserves the Account used to open local data.
 * A boot gate must not remount the person's store when network auth is refused.
 */
import { expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/principal';
import { createSessionAuth } from './create-session-auth.js';

test('session refusal preserves the captured Account', async () => {
	using auth = createSessionAuth({
		authorityId: 'epicenter-api',
		baseURL: 'https://account.test',
		persistedAuthStorage: {
			initial: { token: 'session', principalId: asPrincipalId('alice') },
			set() {},
		},
		launcher: {
			async startSignIn() {
				return { status: 'launched' };
			},
		},
		fetch: async () => new Response(null, { status: 401 }),
	});
	const before = auth.state;
	if (before.status === 'signed-out')
		throw new Error('Expected cached identity');
	await expect(before.account.fetch('/resource')).rejects.toMatchObject({
		code: 'reauth-required',
	});
	expect(auth.state).toEqual({
		status: 'reauth-required',
		account: before.account,
	});
});
