/**
 * Desktop Auth Authority Tests
 *
 * Verifies the Bun singleton's process-generation boundary without involving
 * WebViews or Tauri. The keychain cell is the serialized credential and
 * nothing else: the deployment discriminator went with the second deployment
 * kind (ADR-0325, ADR-0326).
 *
 * Key behaviors:
 * - A stored credential boots the hosted principal offline
 * - Host-owned authorization verifies once and stays outside every WebView
 * - Sign-out clears the cell before requesting relaunch
 */

import { expect, test } from 'bun:test';
import { createDesktopAuthAuthority } from './desktop-auth-authority.ts';

const STORED_CELL = JSON.stringify({
	grant: {
		accessToken: 'access-1',
		refreshToken: 'refresh-1',
		accessTokenExpiresAt: Date.now() + 3_600_000,
	},
	principalId: 'alice',
});

function setup(authCell: string | null = STORED_CELL) {
	const writes: Array<string | null> = [];
	let relaunches = 0;
	const authority = createDesktopAuthAuthority({
		authCell,
		nativeAuthPort: {
			completed: new Promise(() => undefined),
			async storeAuth(serialized) {
				writes.push(serialized);
			},
			async openAuthUrl() {},
			relaunch() {
				relaunches += 1;
			},
			onOAuthCallback() {
				return () => false;
			},
		},
		fetch: async (input) => {
			const url = String(input);
			if (url.endsWith('/api/session')) {
				return Response.json({ principalId: 'alice' });
			}
			if (url.endsWith('/auth/oauth2/revoke')) return new Response(null);
			throw new Error(`Unexpected auth request: ${url}`);
		},
	});
	return {
		authority,
		writes,
		get relaunches() {
			return relaunches;
		},
	};
}

test('a stored cell boots the hosted principal and authorizes after verification', async () => {
	const { authority } = setup();
	expect(authority.bootSnapshot.state.status).toBe('signed-in');
	if (authority.bootSnapshot.state.status !== 'signed-in') {
		throw new Error('Expected signed-in boot snapshot.');
	}
	expect(String(authority.bootSnapshot.state.principalId)).toBe('alice');
	expect(authority.bootSnapshot.connection).toEqual({
		baseURL: 'https://api.epicenter.so',
		status: 'connected',
	});
	expect(authority.bootSnapshot.networkEligible).toBe(false);
	expect(String((await authority.account?.getProfile())?.data?.id)).toBe(
		'alice',
	);
});

test('sign-out clears the cell before requesting relaunch', async () => {
	const runtime = setup();
	const result = await runtime.authority.signOut();
	expect(result.error).toBeNull();
	expect(runtime.writes).toEqual([null]);
	expect(runtime.relaunches).toBe(1);
});

test('an unreadable cell boots signed-out', () => {
	for (const authCell of [
		'not-json',
		'{"deployment":{"kind":"self-hosted"}}',
	]) {
		const { authority } = setup(authCell);
		expect(authority.bootSnapshot.state).toEqual({ status: 'signed-out' });
	}
});
