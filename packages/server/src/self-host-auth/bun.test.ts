/**
 * Bun authentication persistence survives process-owner replacement.
 * Real passkeys and sessions remain usable after reopening the SQLite file;
 * recovery and admission removal remain enforced across later reopenings.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuthenticator } from '../../evidence/enrollment/authenticator.js';
import { openSelfHostAuth } from './bun.js';

const origin = 'https://auth.example.test';

test('file-backed sessions and passkeys survive reopen while recovery and removal remain durable', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'self-host-auth-'));
	const configuration = {
		path: join(directory, 'auth.sqlite'),
		origin,
		callbacks: [],
	};
	let owner = openSelfHostAuth(configuration);
	function reopen() {
		owner.close();
		owner = openSelfHostAuth(configuration);
	}
	async function post(path: string, body: unknown, cookie?: string) {
		return owner.auth.handle(
			new Request(`${origin}/auth/passkey/${path}`, {
				method: 'POST',
				headers: {
					origin,
					'content-type': 'application/json',
					...(cookie ? { cookie } : {}),
				},
				body: JSON.stringify(body),
			}),
		);
	}
	function cookies(response: Response) {
		return response.headers
			.getSetCookie()
			.map((cookie) => cookie.split(';')[0])
			.join('; ');
	}
	function sessionToken(response: Response) {
		const token = response.headers
			.getSetCookie()
			.find((cookie) => cookie.startsWith('__Host-epicenter_session='))
			?.split(';')[0]
			?.slice('__Host-epicenter_session='.length);
		if (!token) throw new Error('Expected session cookie');
		return token;
	}
	const authenticator = await createAuthenticator(origin);
	try {
		const admitted = await owner.auth.admit({ id: 'alice', name: 'Alice' });
		const registration = await post('registration-options', {
			token: admitted.token,
		});
		const pending = (await registration.json()) as {
			id: string;
			options: { challenge: string };
		};
		const registered = await post(
			'register',
			{
				id: pending.id,
				response: await authenticator.register(pending.options.challenge),
			},
			cookies(registration),
		);
		expect(registered.status).toBe(200);
		const original = sessionToken(registered);
		reopen();
		expect((await owner.auth.resolveSession(original))?.userId).toBe('alice');
		const login = await post('authentication-options', {});
		const challenge = (await login.json()) as {
			id: string;
			options: { challenge: string };
		};
		const signedIn = await post(
			'authenticate',
			{
				id: challenge.id,
				response: await authenticator.authenticate(challenge.options.challenge),
			},
			cookies(login),
		);
		expect(signedIn.status).toBe(200);
		const secondSession = sessionToken(signedIn);
		const recovery = await owner.auth.recover('alice');
		reopen();
		expect(await owner.auth.resolveSession(original)).toBeNull();
		expect(await owner.auth.resolveSession(secondSession)).toBeNull();
		const oldLogin = await post('authentication-options', {});
		const oldChallenge = (await oldLogin.json()) as {
			id: string;
			options: { challenge: string };
		};
		expect(
			(
				await post(
					'authenticate',
					{
						id: oldChallenge.id,
						response: await authenticator.authenticate(
							oldChallenge.options.challenge,
						),
					},
					cookies(oldLogin),
				)
			).status,
		).toBe(400);
		expect(
			(await post('registration-options', { token: recovery.token })).status,
		).toBe(200);
		owner.auth.remove('alice');
		reopen();
		expect(
			(await post('registration-options', { token: recovery.token })).status,
		).toBe(400);
		await expect(owner.auth.recover('alice')).rejects.toThrow('not admitted');
		await expect(
			owner.auth.admit({ id: 'alice', name: 'Alice' }),
		).rejects.toThrow();
	} finally {
		owner.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
