/**
 * Worker admission candidate: real SQLite transactions, synthetic verified credentials.
 * Tests grant races, rollback, same-person recovery, removal and server separation.
 * This does not prove passkey/session HTTP integration or production sign-in.
 */
import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { expect, test } from 'vitest';
import type { EnrollmentAdmission } from './admission.js';
import { createAuthenticator, registration } from './authenticator.js';

declare global {
	namespace Cloudflare {
		interface Env {
			ENROLLMENT: DurableObjectNamespace<EnrollmentAdmission>;
		}
	}
}
function server() {
	const stub = env.ENROLLMENT.get(
		env.ENROLLMENT.idFromName(crypto.randomUUID()),
	);
	async function invoke<T>(
		operation: (instance: EnrollmentAdmission) => T | Promise<T>,
	): Promise<T> {
		const result = await runInDurableObject(stub, async (instance) => {
			try {
				return { value: await operation(instance) };
			} catch (error) {
				return { error: String(error) };
			}
		});
		if ('error' in result) throw new Error(result.error);
		return result.value;
	}
	return {
		stub,
		authenticationOptions: () =>
			invoke((instance) => instance.authenticationOptions()),
		authenticate: (...args: Parameters<EnrollmentAdmission['authenticate']>) =>
			invoke((instance) => instance.authenticate(...args)),
		registrationOptions: (token: string) =>
			invoke((instance) => instance.registrationOptions(token)),
		register: (...args: Parameters<EnrollmentAdmission['register']>) =>
			invoke((instance) => instance.register(...args)),
		admit: (id: string) => invoke((instance) => instance.admit(id)),
		begin: (token: string) => invoke((instance) => instance.begin(token)),
		complete: (...args: Parameters<EnrollmentAdmission['complete']>) =>
			invoke((instance) => instance.complete(...args)),
		recover: (id: string) => invoke((instance) => instance.recover(id)),
		remove: (id: string) => invoke((instance) => instance.remove(id)),
		authorize: (token: string) =>
			invoke((instance) => instance.authorize(token)),
		inspect: (id: string) => invoke((instance) => instance.inspect(id)),
	};
}
function credential(id = crypto.randomUUID()) {
	return { id, publicKey: 'synthetic-verified-public-key', counter: 0 };
}

test('independent ceremonies consume one grant and publish one credential/session', async () => {
	const store = server();
	const token = await store.admit('alice');
	const first = await store.begin(token);
	const second = await store.begin(token);
	const results = await Promise.allSettled([
		store.complete(token, first, credential()),
		store.complete(token, second, credential()),
	]);
	expect(
		results.filter((result) => result.status === 'fulfilled'),
	).toHaveLength(1);
	expect(results.filter((result) => result.status === 'rejected')).toHaveLength(
		1,
	);
	const state = await store.inspect('alice');
	expect(state.credentials).toHaveLength(1);
	expect(state.sessions).toHaveLength(1);
	expect(state.grants).toHaveLength(0);
});

for (const phase of ['grant', 'credential', 'session'] as const) {
	test(`failure after ${phase} rolls back all enrollment writes and allows retry`, async () => {
		const store = server();
		const token = await store.admit('alice');
		const ceremony = await store.begin(token);
		await expect(
			store.complete(token, ceremony, credential(), phase),
		).rejects.toThrow('Injected');
		const failed = await store.inspect('alice');
		expect(failed.credentials).toHaveLength(0);
		expect(failed.sessions).toHaveLength(0);
		expect(failed.grants).toHaveLength(1);
		const session = await store.complete(token, ceremony, credential());
		expect(await store.authorize(session)).toBe('alice');
	});
}

test('recovery preserves Alice and invalidates old access and pending ceremonies', async () => {
	const store = server();
	const token = await store.admit('alice');
	const ceremony = await store.begin(token);
	const session = await store.complete(token, ceremony, credential());
	const staleRecovery = await store.recover('alice');
	const staleCeremony = await store.begin(staleRecovery);
	const recovery = await store.recover('alice');
	expect(await store.authorize(session)).toBeNull();
	await expect(
		store.complete(staleRecovery, staleCeremony, credential()),
	).rejects.toThrow('Grant is invalid');
	const replacement = await store.complete(
		recovery,
		await store.begin(recovery),
		credential(),
	);
	expect(await store.authorize(replacement)).toBe('alice');
	const state = await store.inspect('alice');
	expect(state.person).toEqual([{ id: 'alice', admitted: 1, revision: 3 }]);
	expect(state.credentials).toHaveLength(1);
	expect(state.sessions).toHaveLength(1);
});

test('removal between verification and commit refuses enrollment and recovery; Bob remains admitted', async () => {
	const store = server();
	const alice = await store.admit('alice');
	const ceremony = await store.begin(alice);
	const bob = await store.admit('bob');
	const session = await store.complete(
		bob,
		await store.begin(bob),
		credential(),
	);
	await store.remove('alice');
	await expect(store.complete(alice, ceremony, credential())).rejects.toThrow(
		'Grant is invalid',
	);
	await expect(store.recover('alice')).rejects.toThrow(
		'Person is not admitted',
	);
	expect(await store.authorize(session)).toBe('bob');
});

test('another person or server cannot redeem an enrollment grant', async () => {
	const a = server();
	const b = server();
	const token = await a.admit('alice');
	await b.admit('alice');
	const ceremony = await a.begin(token);
	await expect(
		a.complete(token, { ...ceremony, person: 'bob' }, credential()),
	).rejects.toThrow('Ceremony owner changed');
	await expect(b.begin(token)).rejects.toThrow('Grant is invalid');
	const session = await a.complete(token, ceremony, credential());
	expect(await b.authorize(session)).toBeNull();
});

test('an expired grant cannot publish a credential or session', async () => {
	const store = server();
	const token = await store.admit('alice');
	const ceremony = await store.begin(token);
	await runInDurableObject(store.stub, (_instance, state) => {
		state.storage.sql.exec('UPDATE grant_token SET expires = 0');
	});
	await expect(store.complete(token, ceremony, credential())).rejects.toThrow(
		'Grant is invalid',
	);
	expect((await store.inspect('alice')).credentials).toHaveLength(0);
});

test('real Worker WebAuthn enrollment and recovery publish a usable same-person session', async () => {
	const store = server();
	const token = await store.admit('alice');
	const first = await store.registrationOptions(token);
	const response = await registration(
		first.options.challenge,
		'https://enrollment.example.test',
	);
	const session = await store.register(first.id, response);
	expect(await store.authorize(session)).toBe('alice');
	await expect(store.register(first.id, response)).rejects.toThrow(
		'Ceremony is invalid',
	);
	const recovery = await store.recover('alice');
	expect(await store.authorize(session)).toBeNull();
	const replacement = await store.registrationOptions(recovery);
	const next = await store.register(
		replacement.id,
		await registration(
			replacement.options.challenge,
			'https://enrollment.example.test',
		),
	);
	expect(await store.authorize(next)).toBe('alice');
	expect((await store.inspect('alice')).credentials).toHaveLength(1);
});

test('wrong-origin response leaves the grant usable but publishes no credential', async () => {
	const store = server();
	const token = await store.admit('alice');
	const ceremony = await store.registrationOptions(token);
	await expect(
		store.register(
			ceremony.id,
			await registration(
				ceremony.options.challenge,
				'https://attacker.example.test',
			),
		),
	).rejects.toThrow();
	expect((await store.inspect('alice')).credentials).toHaveLength(0);
	expect((await store.begin(token)).person).toBe('alice');
});

test('two real Worker registration responses cannot redeem one grant twice', async () => {
	const store = server();
	const token = await store.admit('alice');
	const first = await store.registrationOptions(token);
	const second = await store.registrationOptions(token);
	const a = await registration(
		first.options.challenge,
		'https://enrollment.example.test',
	);
	const b = await registration(
		second.options.challenge,
		'https://enrollment.example.test',
	);
	const results = await Promise.allSettled([
		store.register(first.id, a),
		store.register(second.id, b),
	]);
	expect(
		results.filter((result) => result.status === 'fulfilled'),
	).toHaveLength(1);
	expect(results.filter((result) => result.status === 'rejected')).toHaveLength(
		1,
	);
	expect((await store.inspect('alice')).credentials).toHaveLength(1);
});

test('committed enrollment and unused ceremonies survive object eviction', async () => {
	const store = server();
	const token = await store.admit('alice');
	const ceremony = await store.registrationOptions(token);
	await evictDurableObject(store.stub);
	const response = await registration(
		ceremony.options.challenge,
		'https://enrollment.example.test',
	);
	const session = await store.register(ceremony.id, response);
	await evictDurableObject(store.stub);
	expect(await store.authorize(session)).toBe('alice');
	await expect(store.register(ceremony.id, response)).rejects.toThrow(
		'Ceremony is invalid',
	);
	await expect(store.begin(token)).rejects.toThrow('Grant is invalid');
});

test('duplicate credential insertion rolls back grant consumption', async () => {
	const store = server();
	const alice = await store.admit('alice');
	const bob = await store.admit('bob');
	const key = credential();
	await store.complete(alice, await store.begin(alice), key);
	await expect(
		store.complete(bob, await store.begin(bob), key),
	).rejects.toThrow();
	expect((await store.begin(bob)).person).toBe('bob');
	expect((await store.inspect('bob')).sessions).toHaveLength(0);
});

for (const operation of ['remove', 'recover'] as const) {
	test(`${operation} during real registration verification prevents credential publication`, async () => {
		const store = server();
		const token = await store.admit('alice');
		const ceremony = await store.registrationOptions(token);
		const response = await registration(
			ceremony.options.challenge,
			'https://enrollment.example.test',
		);
		const outcome = await runInDurableObject(store.stub, async (instance) => {
			// register reads the durable ceremony synchronously, then yields to verification.
			const pending = instance.register(ceremony.id, response).then(
				(value) => ({ value }),
				(error) => ({ error: String(error) }),
			);
			await instance[operation]('alice');
			return pending;
		});
		expect(outcome).toHaveProperty('error');
		expect((await store.inspect('alice')).credentials).toHaveLength(0);
		expect((await store.inspect('alice')).sessions).toHaveLength(0);
	});
}

test('the enrolled private key signs in after eviction, and recovery refuses that old key', async () => {
	const store = server();
	const key = await createAuthenticator('https://enrollment.example.test');
	const token = await store.admit('alice');
	const enrollment = await store.registrationOptions(token);
	await store.register(
		enrollment.id,
		await key.register(enrollment.options.challenge),
	);
	await evictDurableObject(store.stub);
	const login = await store.authenticationOptions();
	const assertion = await key.authenticate(login.options.challenge);
	const session = await store.authenticate(login.id, assertion);
	expect(await store.authorize(session)).toBe('alice');
	await expect(store.authenticate(login.id, assertion)).rejects.toThrow();
	await store.recover('alice');
	const oldKeyLogin = await store.authenticationOptions();
	await expect(
		store.authenticate(
			oldKeyLogin.id,
			await key.authenticate(oldKeyLogin.options.challenge),
		),
	).rejects.toThrow('Authentication is invalid');
	expect(await store.authorize(session)).toBeNull();
});

for (const operation of ['remove', 'recover'] as const) {
	test(`${operation} during real signature verification prevents session issuance`, async () => {
		const store = server();
		const key = await createAuthenticator('https://enrollment.example.test');
		const token = await store.admit('alice');
		const enrollment = await store.registrationOptions(token);
		await store.register(
			enrollment.id,
			await key.register(enrollment.options.challenge),
		);
		const login = await store.authenticationOptions();
		const response = await key.authenticate(login.options.challenge);
		const outcome = await runInDurableObject(store.stub, async (instance) => {
			const pending = instance.authenticate(login.id, response).then(
				(value) => ({ value }),
				(error) => ({ error: String(error) }),
			);
			await instance[operation]('alice');
			return pending;
		});
		expect(outcome).toHaveProperty('error');
		expect((await store.inspect('alice')).sessions).toHaveLength(0);
	});
}
