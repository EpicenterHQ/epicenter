import { expect, mock, test } from 'bun:test';
import type { Account, AuthClient } from '@epicenter/auth';

const SERVER = 'https://api.example.test';
const GIT = 'https://git.example.test';
const NAMESPACE = 'abcdefghij12';

const requests: { url: string }[] = [];
let answers: (url: string) => Response = () =>
	new Response(null, { status: 404 });
const account = {
	authorityId: 'epicenter-api',
	principalId: 'user-1',
	baseURL: SERVER,
	fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		requests.push({ url: request.url });
		return answers(request.url);
	},
	getProfile: async () => {
		throw new Error('unused');
	},
} as unknown as Account;
let signedIn = true;
mock.module('#platform/auth', () => ({
	auth: {
		baseURL: SERVER,
		getState: () =>
			signedIn ? { status: 'signed-in', account } : { status: 'signed-out' },
	} as unknown as AuthClient,
}));
// The Git origin of an Epicenter-hosted server is not the API's.
mock.module('@epicenter/constants/apps', () => ({
	resolveOAuthAudiences: () => ({
		api: SERVER,
		git: GIT,
		mcp: `${SERVER}/mcp`,
	}),
}));

const { connectEpicenter, httpFetch, isEpicenter, proposedName } = await import(
	'./remote.js'
);

const listing = {
	namespaces: [
		{
			id: NAMESPACE,
			title: 'x',
			personal: true,
			role: 'owner',
			repositories: [],
		},
	],
};

test('the proposed name is the folder directory, made a valid name', () => {
	expect(proposedName).toBe('so.epicenter.todos');
});

test('Connect finds the personal namespace and answers its remote, creating nothing', async () => {
	requests.length = 0;
	answers = (url) =>
		url.endsWith('/api/repos')
			? Response.json(listing)
			: new Response(null, { status: 500 });
	const result = await connectEpicenter('notes');
	expect(result.data).toBe(`${GIT}/${NAMESPACE}/notes.git`);
	// The first sync's push creates the repository; Connect sends no Git request.
	expect(requests.map(({ url }) => url)).toEqual([`${SERVER}/api/repos`]);
});

test('Connect reports a refusal, and a signed-out page asks for sign-in', async () => {
	answers = () => Response.json({ error_description: 'no' }, { status: 403 });
	expect((await connectEpicenter('notes')).error?.name).toBe('Refused');
	signedIn = false;
	expect((await connectEpicenter('notes')).error?.name).toBe('SignInRequired');
	signedIn = true;
});

test('only the hosted Git origin gets the account; other remotes use plain fetch', async () => {
	expect(isEpicenter(`${GIT}/${NAMESPACE}/notes.git`)).toBe(true);
	expect(isEpicenter('https://github.com/a/b.git')).toBe(false);
	requests.length = 0;
	answers = () => new Response('ok');
	await httpFetch(`${GIT}/${NAMESPACE}/notes.git/git-upload-pack`, {
		method: 'POST',
	});
	expect(requests).toHaveLength(1);
	const seen: string[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		seen.push(String(input));
		return new Response('plain');
	}) as typeof fetch;
	try {
		await httpFetch('https://git.elsewhere.test/a/b.git/info/refs');
	} finally {
		globalThis.fetch = realFetch;
	}
	expect(seen).toEqual(['https://git.elsewhere.test/a/b.git/info/refs']);
	expect(requests).toHaveLength(1);
});
