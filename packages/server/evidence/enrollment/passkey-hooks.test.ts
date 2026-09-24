/**
 * Installed Better Auth enrollment contract evidence, using real WebAuthn verification.
 * Shows the failure boundary between a grant hook and credential persistence.
 * The memory adapter proves plugin ordering only, not durable Worker admission.
 */
import { expect, test } from 'bun:test';
import { passkey } from '@better-auth/passkey';
import { betterAuth } from 'better-auth';
import { type MemoryDB, memoryAdapter } from 'better-auth/adapters/memory';
import { registration } from './authenticator.js';

const origin = 'https://enrollment.example.test';
function setup(failInsert = false) {
	const db: MemoryDB = {
		user: [],
		session: [],
		account: [],
		verification: [],
		passkey: [],
	};
	let consumed = false;
	const adapter = memoryAdapter(db);
	const auth = betterAuth({
		baseURL: origin,
		secret: 'test-only-enrollment-secret-with-at-least-32-bytes',
		logger: { disabled: true },
		database: (options) => {
			const instance = adapter(options);
			return {
				...instance,
				async create(input) {
					if (input.model === 'passkey' && failInsert)
						throw new Error('Injected insert failure');
					return instance.create(input);
				},
			};
		},
		plugins: [
			passkey({
				rpID: new URL(origin).hostname,
				origin,
				registration: {
					requireSession: false,
					resolveUser: async ({ context }) => {
						if (context !== 'operator-grant' || consumed)
							throw new Error('Invalid grant');
						return { id: 'alice', name: 'Alice' };
					},
					afterVerification: async () => {
						if (consumed) throw new Error('Grant already used');
						consumed = true;
					},
				},
			}),
		],
	});
	async function begin() {
		const options = await auth.handler(
			new Request(
				`${origin}/api/auth/passkey/generate-register-options?context=operator-grant`,
			),
		);
		expect(options.status).toBe(200);
		const body = (await options.json()) as { challenge: string };
		const cookie = options.headers
			.getSetCookie()
			.map((value) => value.split(';')[0])
			.join('; ');
		const response = await registration(body.challenge, origin);
		return () =>
			auth.handler(
				new Request(`${origin}/api/auth/passkey/verify-registration`, {
					method: 'POST',
					headers: { origin, cookie, 'content-type': 'application/json' },
					body: JSON.stringify({ response }),
				}),
			);
	}
	return {
		begin,
		db,
		get consumed() {
			return consumed;
		},
	};
}

test('real registration reaches the hook and inserts a credential for its resolved user', async () => {
	const fixture = setup();
	const finish = await fixture.begin();
	expect((await finish()).status).toBe(200);
	expect(fixture.consumed).toBe(true);
	expect(fixture.db.passkey).toHaveLength(1);
	expect(fixture.db.passkey?.[0]?.userId).toBe('alice');
	// resolveUser does not provision a Better Auth user or issue a session.
	expect(fixture.db.user).toHaveLength(0);
	expect(fixture.db.session).toHaveLength(0);
	expect((await finish()).status).toBe(400);
});

test('credential insertion failure leaves the hook-consumed grant spent', async () => {
	const fixture = setup(true);
	const finish = await fixture.begin();
	expect((await finish()).status).toBe(500);
	expect(fixture.consumed).toBe(true);
	expect(fixture.db.passkey).toHaveLength(0);
	expect(fixture.db.session).toHaveLength(0);
	expect((await finish()).status).toBe(400);
});

test('a hook rejects the second ceremony after consuming their shared grant', async () => {
	const fixture = setup();
	const first = await fixture.begin();
	const second = await fixture.begin();
	const responses = await Promise.all([first(), second()]);
	expect(responses.map((response) => response.status).sort()).toEqual([
		200, 500,
	]);
	expect(fixture.db.passkey).toHaveLength(1);
});
