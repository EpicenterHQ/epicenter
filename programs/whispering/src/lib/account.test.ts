/** Whispering's sign-in in a browser (`connectAccount` as `app.ts` asks for it): Epicenter's hosted models send through its `fetch`, as a Tauri window's do through the shell, and follow sign-out without a new merge. */
import { afterEach, expect, test } from 'bun:test';
import { epicenterCloud, selfHostedServer } from '@epicenter/account';
import { APPS, resolveOAuthAudiences } from '@epicenter/definition/site';
import { APP_URLS, SELF_HOST_ORIGIN } from '@epicenter/vite-config/app-urls';
import { expectOk } from 'wellcrafted/testing';

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
			[audiences.folders]: { accessToken: 'test-folders-token', expiresAt },
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

const { hosted: hostedModels, openAi } = await import('@epicenter/ai');
const { connectAccount } = await import('@epicenter/account');
const account = connectAccount({
	clientId: APPS.WHISPERING.id,
	api: APP_URLS.API,
	selfHosted: SELF_HOST_ORIGIN,
	automaticRenewal: false,
});
afterEach(() => {
	sent.length = 0;
});

test('Epicenter’s models are sent with the account’s bearer, and once signed out the same endpoint sends nothing', async () => {
	const ai = openAi([hostedModels(account)]);
	const origin = new URL(server.baseURL).origin;
	const hosted = ai.endpoints().find(({ id }) => id === 'hosted')!;
	expect(hosted.baseUrl).toBe(`${origin}/v1`);
	expect(hosted.models().length).toBeGreaterThan(0);
	expect((await hosted.fetch('chat/completions', { method: 'POST' })).ok).toBe(
		true,
	);
	expect(sent).toEqual([
		{
			url: `${origin}/v1/chat/completions`,
			authorization: 'Bearer test-token',
		},
	]);

	expectOk(await account.signOut());
	sent.length = 0;
	expect(ai.endpoints().find(({ id }) => id === 'hosted')).toBe(hosted);
	expect(hosted.baseUrl).toBe(`${origin}/v1`);
	expect(hosted.models()).toEqual([]);
	const refusal = await hosted
		.fetch('chat/completions', { method: 'POST' })
		.catch((cause: Error) => cause);
	expect(refusal).toBeInstanceOf(Error);
	expect((refusal as Error).name).toBe('SignedOut');
	expect(sent).toEqual([]);
	account[Symbol.dispose]();
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	for (const [key, descriptor] of Object.entries(originals)) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});
