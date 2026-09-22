/** Endpoint owners fence destinations before credentials and drain delayed authentication. */
import { expect, test } from 'bun:test';
import { createInference } from './inference.js';

test('captured authentication overrides SDK headers and refuses destination changes before resolving credentials', async () => {
	let resolved = 0;
	const requests: Request[] = [];
	const owner = createInference(
		{
			baseURL: 'https://example.test/v1',
			fetch: async (input, init) => {
				expect(init?.credentials).toBe('omit');
				expect(init?.redirect).toBe('error');
				requests.push(new Request(input, init));
				return Response.json({ data: [] });
			},
		},
		() => {
			resolved++;
			return {
				Authorization: 'Bearer captured',
				'cf-aig-authorization': 'Bearer gateway',
			};
		},
	);
	await owner.client.models.list({
		headers: {
			authorization: 'Bearer caller',
			'cf-aig-authorization': 'caller',
			cookie: 'ambient',
		},
	});
	expect(requests[0]!.headers.get('authorization')).toBe('Bearer captured');
	expect(requests[0]!.headers.get('cf-aig-authorization')).toBe(
		'Bearer gateway',
	);
	expect(requests[0]!.headers.get('cookie')).toBeNull();
	owner.client.baseURL = 'https://foreign.test/v1';
	await expect(
		(async () => await owner.client.models.list())(),
	).rejects.toThrow();
	expect(resolved).toBe(1);
	await owner.close();
});

test('close during credential resolution waits and never dispatches the resolved token', async () => {
	const started = Promise.withResolvers<void>();
	const token = Promise.withResolvers<HeadersInit>();
	let requests = 0;
	let signal: AbortSignal | undefined;
	const owner = createInference(
		{
			baseURL: 'https://example.test/v1',
			fetch: async () => {
				requests++;
				return Response.json({ data: [] });
			},
		},
		(options) => {
			signal = options.signal;
			started.resolve();
			return token.promise;
		},
	);
	const request = (async () => await owner.client.models.list())().catch(
		() => 'cancelled',
	);
	await started.promise;
	let closed = false;
	const closing = owner.close();
	expect(owner.close()).toBe(closing);
	void closing.then(() => {
		closed = true;
	});
	await Promise.resolve();
	expect(signal?.aborted).toBe(true);
	expect(closed).toBe(false);
	token.resolve({ Authorization: 'Bearer late' });
	await closing;
	expect(await request).toBe('cancelled');
	expect(requests).toBe(0);
});

test('credential failure never dispatches an unauthenticated request', async () => {
	let requests = 0;
	const owner = createInference(
		{
			baseURL: 'https://example.test/v1',
			fetch: async () => {
				requests++;
				return Response.json({ data: [] });
			},
		},
		async () => {
			throw new Error('token failed');
		},
	);
	await expect(
		(async () => await owner.client.models.list())(),
	).rejects.toThrow();
	expect(requests).toBe(0);
	await owner.close();
});
