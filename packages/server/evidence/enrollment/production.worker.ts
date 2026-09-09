/**
 * Production self-host Worker operator RPC, HTTP ceremonies, and /api/session.
 * Real passkey proofs bind browser cookies, admission and independent client handoff.
 */
import { env, SELF, evictDurableObject } from 'cloudflare:test';
import { expect, test } from 'vitest';
import type { SelfHostAuthOwner } from '../../src/self-host-auth/worker.js';
import type { SelfHostOperator } from '../../../../apps/self-host/worker/operator.js';
import { createAuthenticator } from './authenticator.js';

declare global {
	namespace Cloudflare {
		interface Env {
			SELF_HOST_AUTH: DurableObjectNamespace<SelfHostAuthOwner>;
			OPERATOR: Service<SelfHostOperator>;
		}
	}
}
const origin = 'https://enrollment.example.test';
const callback = 'https://notes.example.test/auth/callback';
function owner() {
	return env.SELF_HOST_AUTH.get(env.SELF_HOST_AUTH.idFromName('deployment'));
}
function browser() {
	const cookies = new Map<string, string>();
	return async (path: string, body: unknown) => {
		const response = await SELF.fetch(`${origin}${path}`, {
			method: 'POST',
			headers: {
				origin,
				'content-type': 'application/json',
				cookie: [...cookies]
					.map(([key, value]) => `${key}=${value}`)
					.join('; '),
			},
			body: JSON.stringify(body),
		});
		for (const cookie of response.headers.getSetCookie()) {
			const part = cookie.split(';')[0]!;
			const index = part.indexOf('=');
			cookies.set(part.slice(0, index), part.slice(index + 1));
		}
		return new Response(await response.arrayBuffer(), {
			status: response.status,
			headers: response.headers,
		});
	};
}
async function enroll(id: string) {
	const grant = await env.OPERATOR.admit({ id, name: id });
	const request = browser();
	const key = await createAuthenticator(origin);
	const optionsResponse = await request('/auth/passkey/registration-options', {
		token: new URLSearchParams(new URL(grant.url).hash.slice(1)).get('enroll'),
	});
	expect(optionsResponse.status).toBe(200);
	const ceremony = await optionsResponse.json<{
		id: string;
		options: { challenge: string };
	}>();
	expect(
		(
			await request('/auth/passkey/register', {
				id: ceremony.id,
				response: await key.register(ceremony.options.challenge),
			})
		).status,
	).toBe(200);
	return { request, key };
}
async function handoff(request: ReturnType<typeof browser>) {
	const verifier = 'a'.repeat(43);
	const state = 'b'.repeat(32);
	const challenge = btoa(
		String.fromCharCode(
			...new Uint8Array(
				await crypto.subtle.digest(
					'SHA-256',
					new TextEncoder().encode(verifier),
				),
			),
		),
	)
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '');
	const authorized = await request('/auth/session/authorize', {
		callback,
		verifier,
		challenge,
		state,
	});
	expect(authorized.status).toBe(200);
	const url = new URL((await authorized.json<{ url: string }>()).url);
	const body = {
		callback,
		verifier,
		state,
		code: url.searchParams.get('code'),
	};
	const redeem = async () => {
		const response = await SELF.fetch(`${origin}/auth/session/redeem`, {
			method: 'POST',
			headers: {
				origin: new URL(callback).origin,
				'content-type': 'application/json',
			},
			body: JSON.stringify(body),
		});
		return new Response(await response.arrayBuffer(), {
			status: response.status,
			headers: response.headers,
		});
	};
	return redeem;
}

test('Alice and Bob hand off independent no-email sessions; removal refuses Alice after owner restart', async () => {
	const aliceId = `alice-${crypto.randomUUID()}`;
	const bobId = `bob-${crypto.randomUUID()}`;
	const alice = await enroll(aliceId);
	const bob = await enroll(bobId);
	const aliceRedeem = await handoff(alice.request);
	const bobRedeem = await handoff(bob.request);
	const aliceResponse = await aliceRedeem();
	const bobResponse = await bobRedeem();
	expect(aliceResponse.status).toBe(200);
	expect(bobResponse.status).toBe(200);
	const aliceToken = (await aliceResponse.json<{ token: string }>()).token;
	const bobToken = (await bobResponse.json<{ token: string }>()).token;
	const profile = (token: string) =>
		SELF.fetch(`${origin}/api/session`, {
			headers: { authorization: `Bearer ${token}` },
		});
	expect(await (await profile(aliceToken)).json()).toEqual({
		principalId: aliceId,
	});
	expect(await (await profile(bobToken)).json()).toEqual({
		principalId: bobId,
	});
	expect((await aliceRedeem()).status).toBe(400);
	await evictDurableObject(owner());
	expect(await (await profile(aliceToken)).json()).toEqual({
		principalId: aliceId,
	});
	await env.OPERATOR.remove(aliceId);
	expect((await profile(aliceToken)).status).toBe(401);
	expect(await (await profile(bobToken)).json()).toEqual({
		principalId: bobId,
	});
	expect((await SELF.fetch(`${origin}/api/session`)).status).toBe(401);
});

test('removal invalidates a previously issued handoff before redemption', async () => {
	const id = `alice-${crypto.randomUUID()}`;
	const { request } = await enroll(id);
	const redeem = await handoff(request);
	await env.OPERATOR.remove(id);
	expect((await redeem()).status).toBe(400);
});

test('registration completion requires the browser that began the ceremony', async () => {
	const id = `alice-${crypto.randomUUID()}`;
	const grant = await env.OPERATOR.admit({ id, name: 'Alice' });
	const first = browser();
	const other = browser();
	const key = await createAuthenticator(origin);
	const response = await first('/auth/passkey/registration-options', {
		token: new URLSearchParams(new URL(grant.url).hash.slice(1)).get('enroll'),
	});
	const ceremony = await response.json<{
		id: string;
		options: { challenge: string };
	}>();
	const body = {
		id: ceremony.id,
		response: await key.register(ceremony.options.challenge),
	};
	expect((await other('/auth/passkey/register', body)).status).toBe(400);
	expect((await first('/auth/passkey/register', body)).status).toBe(200);
});

test('recovery link preserves Alice and invalidates her old session', async () => {
	const id = `alice-${crypto.randomUUID()}`;
	const alice = await enroll(id);
	const response = await (await handoff(alice.request))();
	const { token } = await response.json<{ token: string }>();
	const grant = await env.OPERATOR.recover(id);
	expect(new URL(grant.url).origin).toBe(origin);
	expect(
		(
			await SELF.fetch(`${origin}/api/session`, {
				headers: { authorization: `Bearer ${token}` },
			})
		).status,
	).toBe(401);
	const replacement = browser();
	const key = await createAuthenticator(origin);
	const options = await replacement('/auth/passkey/registration-options', {
		token: new URLSearchParams(new URL(grant.url).hash.slice(1)).get('enroll'),
	});
	const ceremony = await options.json<{
		id: string;
		options: { challenge: string };
	}>();
	expect(
		(
			await replacement('/auth/passkey/register', {
				id: ceremony.id,
				response: await key.register(ceremony.options.challenge),
			})
		).status,
	).toBe(200);
	const next = await (await handoff(replacement))();
	const fresh = await next.json<{ token: string }>();
	expect(
		await (
			await SELF.fetch(`${origin}/api/session`, {
				headers: { authorization: `Bearer ${fresh.token}` },
			})
		).json(),
	).toEqual({ principalId: id });
	await env.OPERATOR.remove(id);
});

test('public HTTP cannot invoke operator admission, recovery, or removal', async () => {
	for (const operation of ['admit', 'recover', 'remove']) {
		for (const path of [
			`/${operation}`,
			`/auth/${operation}`,
			`/operator/${operation}`,
		]) {
			const response = await SELF.fetch(`${origin}${path}`, {
				method: 'POST',
				headers: { origin, 'content-type': 'application/json' },
				body: JSON.stringify({ id: 'unauthorized-alice', name: 'Alice' }),
			});
			expect(response.status).toBe(404);
		}
	}
});
