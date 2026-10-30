/** Browser hosted inference uses the same Account.fetch contract as the desktop route. */
import { afterEach, expect, test } from 'bun:test';
import { epicenterCloud, selfHostedServer } from '@epicenter/auth';
import { APPS, resolveOAuthAudiences } from '@epicenter/constants/apps';
import { APP_URLS, SELF_HOST_ORIGIN } from '@epicenter/constants/vite';
import { expectOk } from 'wellcrafted/testing';
import type { WhisperingFolder } from '../folder.js';

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
const { getAuth } = await import('./auth.js');
afterEach(() => {
	sent.length = 0;
});

test('a selected account captures its bearer, and switching back restores the custom endpoint', async () => {
	const browser = createServices({} as WhisperingFolder);
	expectOk(
		await browser.connections.set('text', {
			baseUrl: 'https://custom.test/v1',
			model: 'custom-model',
			key: { action: 'replace', key: 'custom-key' },
		}),
	);
	const hosted = expectOk(await browser.connections.useAccount!('text'));
	expect(hosted.text?.source).toBe('account');
	expect(hosted.text?.baseUrl).toBe(`${new URL(server.baseURL).origin}/v1`);
	expect(JSON.stringify(hosted)).not.toContain('test-token');
	expectOk(
		await browser.transform({
			expectedBaseUrl: hosted.text!.baseUrl,
			model: hosted.text!.model,
			prompt: 'Fix it.',
			input: 'some text',
		}),
	);
	expect(sent).toEqual([
		{
			url: `${hosted.text!.baseUrl}/chat/completions`,
			authorization: 'Bearer test-token',
		},
	]);
	expectOk(await getAuth().signOut());
	sent.length = 0;
	const signedOut = await browser.connections.read();
	expect(signedOut.text?.source).toBe('account');
	expect(signedOut.text?.keyPresent).toBe(false);
	const refused = await browser.transform({
		expectedBaseUrl: hosted.text!.baseUrl,
		model: hosted.text!.model,
		prompt: 'Fix it.',
		input: 'some text',
	});
	expect(refused.error?.name).toBe('ConnectionUnavailable');
	expect(sent).toEqual([]);
	const custom = expectOk(await browser.connections.useCustom!('text'));
	expect(custom.text?.baseUrl).toBe('https://custom.test/v1');
	expect(custom.text?.source).toBeUndefined();
	getAuth()[Symbol.dispose]();
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	for (const [key, descriptor] of Object.entries(originals)) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});
