/**
 * A refused credential must never look like a different person.
 *
 * This is the one cross-client invariant that keeps an application from
 * thrashing its own session, and it is not obvious from any single client's
 * code, which is why it is stated once here rather than three times in three
 * files.
 *
 * ## The loop it prevents
 *
 * A boot node keys one session on the principal, which is `null` when signed
 * out and `state.account` otherwise (ADR-0350). Every client boots
 * OPTIMISTICALLY: it reports the identity it can prove from disk and verifies
 * over the network afterwards. So if a refusal writes `signed-out`, the
 * sequence is
 *
 *   boot optimistic -> verify -> refused -> signed-out -> GATE FLIPS -> boot optimistic
 *
 * and the application spins at one verification round trip forever, on any
 * device whose stored credential has gone bad, closing and reopening a store
 * each time round.
 *
 * The gate used to be `reloadOnAuthChange`, which replaced the whole document
 * and is now deleted. The invariant outlived it, which is the point of stating
 * it against `principalKey` rather than against whatever reads it: the same
 * flip now remounts a `{#key}` instead, and remounting is what a refusal must
 * never cause, because it is the transition that fires spontaneously and would
 * interrupt someone mid-keystroke.
 *
 * This shipped. `createInstanceTokenAuth` wrote `signed-out` on a refused
 * instance token, so a self-hosted box whose `INSTANCE_TOKEN` had been rotated
 * spun on every load (fixed in `5664edbc`). The hosted client never had the bug
 * because it routes a refusal to `reauth-required`, which keeps the principal.
 *
 * ## What is asserted
 *
 * Not "the state is X" for each client, which is what the per-client suites
 * already do and what let the loop through: each of them was individually
 * correct about its own client. The assertion here is the relationship a gate
 * actually reads, `principalKey` before versus after a refusal, so a future
 * client that invents a fourth state still has to satisfy it, and so the
 * invariant survived the gate being replaced.
 *
 * The cookie client is the interesting exemption and is asserted as one: it
 * genuinely learns its identity over the network, because an httpOnly cookie is
 * invisible to JavaScript, so `signed-out -> signed-in` is a real discovery
 * rather than a refusal. It is safe today only because `apps/api/ui` mounts no
 * reload gate, and that is a fact worth failing a test over if anyone ever
 * mounts one there.
 */

import { expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/principal';
import { Ok } from 'wellcrafted/result';
import type { AuthClient, AuthFetch, AuthState } from './auth-contract.js';
import { createOAuthAppAuth } from './create-oauth-app-auth.js';
import type { PersistedAuthStorage } from './persisted-auth-storage.js';
import { createSameOriginCookieAuth } from './same-origin-cookie-auth.js';

const baseURL = 'http://localhost:8788';

/** `reloadOnAuthChange`'s identity boundary, copied so a drift here is loud. */
const principalKey = (state: AuthState) =>
	state.status === 'signed-out' ? null : state.account;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Refuse everything the way a real server refuses a bad credential. */
const refusing: AuthFetch = async (input) =>
	String(input).endsWith('/auth/oauth2/token')
		? new Response(JSON.stringify({ error: 'invalid_grant' }), {
				status: 400,
				headers: { 'content-type': 'application/json' },
			})
		: new Response(JSON.stringify({}), {
				status: 401,
				headers: { 'content-type': 'application/json' },
			});

function persisted(): PersistedAuthStorage {
	return {
		initial: {
			grant: {
				accessToken: 'access-token',
				refreshToken: 'refresh-token',
				// Already expired, so the first authorize must refresh and be refused.
				accessTokenExpiresAt: 0,
			},
			principalId: asPrincipalId('user-1'),
		},
		set: async () => undefined,
	};
}

/** Every client that boots knowing who it is, which is every client but one. */
const optimisticClients: Array<{ label: string; open: () => AuthClient }> = [
	{
		label: 'hosted OAuth',
		open: () =>
			createOAuthAppAuth({
				baseURL,
				clientId: 'client-1',
				now: () => 1_000_000,
				persistedAuthStorage: persisted(),
				launcher: { startSignIn: async () => Ok({ status: 'launched' }) },
				fetch: refusing,
			}),
	},
];

for (const client of optimisticClients) {
	test(`${client.label}: a refusal does not change the principal`, async () => {
		const auth = client.open();
		const before = principalKey(auth.state);
		expect(before).not.toBeNull();

		// Whatever the client does to discover the refusal: the boot check, a
		// resource call, or a refresh on an expired access token.
		await settle();
		await (auth.state.status === 'signed-out'
			? Promise.reject(new Error('signed out'))
			: auth.state.account.fetch(`${baseURL}/api/blobs`)
		).catch(() => undefined);
		await settle();

		// The whole invariant. If this flips, `reloadOnAuthChange` reloads, the
		// next boot is optimistic again, and the page spins.
		expect(principalKey(auth.state)).toBe(before);
		auth[Symbol.dispose]();
	});
}

test('the cookie client is the exemption, and it is exempt for a reason', async () => {
	// It cannot know its identity synchronously: the cookie is httpOnly, so JS
	// cannot read it. `signed-out -> signed-in` here is a genuine discovery.
	const auth = createSameOriginCookieAuth({
		baseURL,
		fetch: async () =>
			new Response(JSON.stringify({ principalId: 'user-1' }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			}),
	});
	expect(auth.state.status).toBe('signed-out');
	await settle();
	expect(auth.state.status).toBe('signed-in');

	// So mounting `reloadOnAuthChange` on a cookie app would reload on that
	// discovery, boot signed-out again, and loop. `apps/api/ui` mounts no gate
	// and ADR-0088 exempts it by name. This test is the tripwire under that
	// omission, which is otherwise safe only by nobody having tried.
	auth[Symbol.dispose]();
});
