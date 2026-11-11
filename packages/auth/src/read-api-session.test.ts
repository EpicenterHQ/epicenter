import { describe, expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/principal';
import type { AuthFetch } from './auth-contract.js';
import { readApiSession } from './read-api-session.js';

const baseURL = 'http://localhost:8788';

function json(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

describe('readApiSession', () => {
	test('returns the validated session on a 200, sending the bearer', async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetch: AuthFetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return json({
				principalId: 'principal-1',
				email: 'principal-1@example.com',
			});
		};
		const { data, error } = await readApiSession({
			baseURL,
			token: 'dev:principal-1',
			fetch,
		});
		expect(error).toBeNull();
		expect(data?.principalId).toBe(asPrincipalId('principal-1'));
		expect(data?.email).toBe('principal-1@example.com');
		expect(calls[0]?.url).toBe(`${baseURL}/api/session`);
		expect(calls[0]?.init?.credentials).toBe('omit');
		expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe(
			'Bearer dev:principal-1',
		);
	});

	for (const status of [401, 403] as const) {
		test(`maps a rejected bearer (${status}) to Rejected`, async () => {
			const fetch: AuthFetch = async () => json({}, status);
			const { error } = await readApiSession({ baseURL, token: 'bad', fetch });
			expect(error).toMatchObject({ name: 'Rejected', status });
		});
	}

	test('maps a thrown fetch to Unreachable', async () => {
		const fetch: AuthFetch = async () => {
			throw new Error('ECONNREFUSED');
		};
		const { error } = await readApiSession({ baseURL, token: 'x', fetch });
		expect(error?.name).toBe('Unreachable');
	});

	test('maps an unexpected status to Unexpected', async () => {
		const fetch: AuthFetch = async () => json({}, 500);
		const { error } = await readApiSession({ baseURL, token: 'x', fetch });
		expect(error?.name).toBe('Unexpected');
	});

	test('maps an unreadable body to Malformed', async () => {
		const fetch: AuthFetch = async () =>
			new Response('not json', {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		const { error } = await readApiSession({ baseURL, token: 'x', fetch });
		expect(error?.name).toBe('Malformed');
	});
});
