/** Browser hosted inference sends through the signed-in account's `fetch`, as the desktop's does through the shell. */
import { afterEach, expect, test } from 'bun:test';
import { epicenterCloud, selfHostedServer } from '@epicenter/account';
import type { Client } from '@epicenter/definition/contract';
import { APPS, resolveOAuthAudiences } from '@epicenter/definition/site';
import { APP_URLS, SELF_HOST_ORIGIN } from '@epicenter/vite-config/app-urls';
import { expectOk } from 'wellcrafted/testing';
import type { Whispering } from '../contract.js';

Bun.plugin({
	name: 'browser-account-build-flag',
	setup(build) {
		build.onLoad({ filter: /\/platform\/browser\.ts$/ }, async ({ path }) => ({
			contents: new Bun.Transpiler({
				loader: 'ts',
				define: { 'import.meta.env.DEV': 'false' },
			}).transformSync(await Bun.file(path).text()),
			loader: 'js',
		}));
	},
});

const saved = new Map<string, string>();
const storage = {
	getItem: (key: string) => saved.get(key) ?? null,
	setItem: (key: string, value: string) => void saved.set(key, value),
	removeItem: (key: string) => void saved.delete(key),
};
const originals = Object.fromEntries(
	['localStorage', 'sessionStorage', 'location'].map((key) => [
		key,
		Object.getOwnPropertyDescriptor(globalThis, key),
	]),
);
for (const key of ['localStorage', 'sessionStorage'] as const)
	Object.defineProperty(globalThis, key, {
		configurable: true,
		value: storage,
	});
Object.defineProperty(globalThis, 'location', {
	configurable: true,
	value: {
		href: 'http://localhost:1420/',
		origin: 'http://localhost:1420',
		search: '',
		assign() {},
		replace() {},
	},
});

const server = SELF_HOST_ORIGIN
	? selfHostedServer(SELF_HOST_ORIGIN)
	: epicenterCloud(APP_URLS.API);
const audiences = resolveOAuthAudiences(server.baseURL);
const expiresAt = Date.now() + 60 * 60_000;
saved.set(
	`${APPS.WHISPERING.id}.oauth:${new URL(server.baseURL).origin}`,
	JSON.stringify({
		tokens: {
			[audiences.api]: { accessToken: 'test-token', expiresAt },
			[audiences.git]: { accessToken: 'test-git-token', expiresAt },
		},
		principalId: 'alice',
		generation: 'test-generation',
	}),
);

const sent: { url: string; authorization: string | null }[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const request = new Request(input, init);
	sent.push({
		url: request.url,
		authorization: request.headers.get('authorization'),
	});
	return Response.json({ choices: [{ message: { content: 'ok' } }] });
}) as typeof fetch;

const { createServices } = await import('./browser.js');
/** The browser's services need nothing of the client they are made over. */
const client = {} as Client<Whispering>;
const { getAuth } = await import('./auth.js');
afterEach(() => {
	sent.length = 0;
});

test('Epicenter’s models are sent with the account’s bearer, and signed out nothing is sent', async () => {
	const browser = createServices(client);
	const origin = new URL(server.baseURL).origin;
	const signedIn = browser.endpoints.hosted();
	expect(signedIn.baseUrl).toBe(`${origin}/v1`);
	expect(signedIn.models().length).toBeGreaterThan(0);
	expect(
		(await signedIn.fetch('chat/completions', { method: 'POST' })).ok,
	).toBe(true);
	expect(sent).toEqual([
		{
			url: `${origin}/v1/chat/completions`,
			authorization: 'Bearer test-token',
		},
	]);

	expectOk(await getAuth().signOut());
	sent.length = 0;
	const signedOut = browser.endpoints.hosted();
	expect(signedOut.baseUrl).toBeUndefined();
	expect(signedOut.models()).toEqual([]);
	const refusal = await signedOut
		.fetch('chat/completions', { method: 'POST' })
		.catch((cause: Error) => cause);
	expect(refusal).toBeInstanceOf(Error);
	expect((refusal as Error).name).toBe('SignedOut');
	expect(sent).toEqual([]);
	getAuth()[Symbol.dispose]();
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	for (const [key, descriptor] of Object.entries(originals)) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});
