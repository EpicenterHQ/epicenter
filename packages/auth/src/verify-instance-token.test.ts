/** Instance token verification returns a credential without opening an Account.
 * Invalid responses fail, and cancellation settles without waiting for a stuck
 * transport or response body. Verification never calls a revocation endpoint.
 */
import { expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/principal';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { verifyInstanceToken } from './create-session-auth.js';

test('verification returns the server-verified principal and supplied token', async () => {
	const requests: string[] = [];
	const signal = new AbortController().signal;
	const credential = expectOk(
		await verifyInstanceToken({
			baseURL: 'https://instance.test',
			token: 'operator',
			signal,
			fetch: async (input, init) => {
				requests.push(String(input));
				expect(new Headers(init?.headers).get('authorization')).toBe(
					'Bearer operator',
				);
				expect(init?.credentials).toBe('omit');
				expect(init?.redirect).toBe('error');
				expect(init?.signal).toBe(signal);
				return Response.json({ principalId: 'instance' });
			},
		}),
	);
	expect(credential).toEqual({
		token: 'operator',
		principalId: asPrincipalId('instance'),
	});
	expect(requests).toEqual(['https://instance.test/api/session']);
});

for (const status of [401, 403, 500]) {
	test(`HTTP ${status} cannot produce a verified credential`, async () => {
		expectErr(
			await verifyInstanceToken({
				baseURL: 'https://instance.test',
				token: 'operator',
				signal: new AbortController().signal,
				fetch: async () => new Response(null, { status }),
			}),
		);
	});
}

test('a successful HTTP response must contain a valid session', async () => {
	expectErr(
		await verifyInstanceToken({
			baseURL: 'https://instance.test',
			token: 'operator',
			signal: new AbortController().signal,
			fetch: async () => Response.json({ token: 'untrusted' }),
		}),
	);
});

test('a Cloud principal cannot produce a verified instance credential', async () => {
	expectErr(
		await verifyInstanceToken({
			baseURL: 'https://instance.test',
			token: 'cloud-token',
			signal: new AbortController().signal,
			fetch: async () => Response.json({ principalId: 'alice' }),
		}),
	);
});

test('an unreachable server cannot produce a verified credential', async () => {
	expectErr(
		await verifyInstanceToken({
			baseURL: 'https://instance.test',
			token: 'operator',
			signal: new AbortController().signal,
			fetch: async () => {
				throw new Error('offline');
			},
		}),
	);
});

test('an already cancelled attempt sends no request', async () => {
	let requests = 0;
	expectErr(
		await verifyInstanceToken({
			baseURL: 'https://instance.test',
			token: 'operator',
			signal: AbortSignal.abort(),
			fetch: async () => {
				requests++;
				return Response.json({ principalId: 'instance' });
			},
		}),
	);
	expect(requests).toBe(0);
});

test('cancellation settles before a transport that ignores abort', async () => {
	const attempt = new AbortController();
	const response = Promise.withResolvers<Response>();
	const pending = verifyInstanceToken({
		baseURL: 'https://instance.test',
		token: 'operator',
		signal: attempt.signal,
		fetch: () => response.promise,
	});
	attempt.abort();
	expectErr(await pending);
	response.resolve(Response.json({ principalId: 'instance' }));
});

test('cancellation also settles while a response body is unfinished', async () => {
	const attempt = new AbortController();
	const reading = Promise.withResolvers<void>();
	const body = new TransformStream<Uint8Array>();
	const writer = body.writable.getWriter();
	const pending = verifyInstanceToken({
		baseURL: 'https://instance.test',
		token: 'operator',
		signal: attempt.signal,
		fetch: async () => {
			reading.resolve();
			return new Response(body.readable);
		},
	});
	await reading.promise;
	await writer.write(new TextEncoder().encode('{"principalId":'));
	attempt.abort();
	expectErr(await pending);
	await writer.write(new TextEncoder().encode('"instance"}'));
	await writer.close();
});
