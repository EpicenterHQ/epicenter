import { expect, test } from 'bun:test';
import type { DesktopAuthAuthority } from './desktop-auth-authority.ts';
import { createDesktopAuthorityFetch } from './desktop-authority-fetch.ts';

type AuthorityTransport = Pick<
	DesktopAuthAuthority,
	'authorize' | 'baseURL' | 'reportRejected'
>;

test('desktop authority fetch never sends a bearer to a foreign origin', async () => {
	let authorizeCalls = 0;
	const requests: Array<{
		authorization: string | null;
		credentials: RequestCredentials | undefined;
		url: string;
	}> = [];
	const authority: AuthorityTransport = {
		baseURL: 'https://api.epicenter.so',
		async authorize() {
			authorizeCalls += 1;
			return {
				status: 'authorized' as const,
				accessToken: 'desktop-secret',
				tokenGeneration: 1,
			};
		},
		reportRejected() {},
	};
	const fetch = createDesktopAuthorityFetch(authority, {
		fetch: async (input, init) => {
			requests.push({
				authorization: new Headers(init?.headers).get('authorization'),
				credentials: init?.credentials,
				url: input instanceof Request ? input.url : String(input),
			});
			return new Response(null, { status: 401 });
		},
	});

	await fetch('https://uploads.example/object', {
		headers: { authorization: 'Bearer caller-supplied' },
	});

	expect(authorizeCalls).toBe(0);
	expect(requests).toEqual([
		{
			authorization: null,
			credentials: 'omit',
			url: 'https://uploads.example/object',
		},
	]);
});

test('desktop authority fetch retries one deployment 401 with a refreshed bearer', async () => {
	const authorizeOptions: Array<{ forceRefresh?: boolean } | undefined> = [];
	const rejectedGenerations: number[] = [];
	const requests: Array<{
		authorization: string | null;
		redirect: RequestRedirect | undefined;
		url: string;
	}> = [];
	const authority: AuthorityTransport = {
		baseURL: 'https://api.epicenter.so',
		async authorize(options) {
			authorizeOptions.push(options);
			const tokenGeneration = options?.forceRefresh ? 2 : 1;
			return {
				status: 'authorized',
				accessToken: `desktop-${tokenGeneration}`,
				tokenGeneration,
			};
		},
		reportRejected(tokenGeneration) {
			rejectedGenerations.push(tokenGeneration);
		},
	};
	let responseNumber = 0;
	const fetch = createDesktopAuthorityFetch(authority, {
		fetch: async (input, init) => {
			requests.push({
				authorization: new Headers(init?.headers).get('authorization'),
				redirect: init?.redirect,
				url: input instanceof Request ? input.url : String(input),
			});
			responseNumber += 1;
			return new Response(null, { status: responseNumber === 1 ? 401 : 204 });
		},
	});

	const response = await fetch('/api/blobs');

	expect(response.status).toBe(204);
	expect(authorizeOptions).toEqual([undefined, { forceRefresh: true }]);
	expect(rejectedGenerations).toEqual([]);
	expect(requests).toEqual([
		{
			authorization: 'Bearer desktop-1',
			redirect: 'manual',
			url: 'https://api.epicenter.so/api/blobs',
		},
		{
			authorization: 'Bearer desktop-2',
			redirect: 'manual',
			url: 'https://api.epicenter.so/api/blobs',
		},
	]);
});

test('desktop authority fetch replays a buffered request body after one deployment 401', async () => {
	const authority: AuthorityTransport = {
		baseURL: 'https://api.epicenter.so',
		async authorize(options) {
			return {
				status: 'authorized',
				accessToken: options?.forceRefresh ? 'refreshed' : 'initial',
				tokenGeneration: options?.forceRefresh ? 2 : 1,
			};
		},
		reportRejected() {},
	};
	const bodies: string[] = [];
	const fetch = createDesktopAuthorityFetch(authority, {
		fetch: async (_input, init) => {
			bodies.push(await new Response(init?.body).text());
			return new Response(null, { status: bodies.length === 1 ? 401 : 204 });
		},
	});

	const response = await fetch('/api/ai/audio/transcriptions', {
		method: 'POST',
		body: new TextEncoder().encode('reusable multipart body'),
	});

	expect(response.status).toBe(204);
	expect(bodies).toEqual([
		'reusable multipart body',
		'reusable multipart body',
	]);
});
