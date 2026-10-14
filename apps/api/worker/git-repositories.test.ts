/**
 * The Artifacts repository store against a scripted binding and a stubbed
 * `fetch`. The binding has no local emulation, so these pin the calls the
 * store makes: the name it derives, the lookup-then-create sequence, which
 * binding errors it absorbs, and the exact upstream request.
 */
import { afterEach, expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/principal';
import {
	type ArtifactsNamespace,
	createArtifactsRepositoryStore,
} from './git-repositories.js';

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const alice = asPrincipalId('alice');
// The first 16 hex characters of `printf alice | shasum -a 256`.
const REPOSITORY = 'so.epicenter.todos.2bd806c97f0e00af';

function artifactsError(code: ArtifactsErrorCode) {
	return Object.assign(new Error(code), { name: 'ArtifactsError', code });
}

/** A binding whose get() and create() answer from scripted queues. */
function scripted(
	gets: ('missing' | 'found' | Error)[],
	creates: ('created' | Error)[] = [],
) {
	const calls: string[] = [];
	const tokens: [string | undefined, number | undefined][] = [];
	const artifacts: ArtifactsNamespace = {
		async get(name) {
			calls.push(`get ${name}`);
			const next = gets.shift();
			if (next === 'missing') throw artifactsError('NOT_FOUND');
			if (next instanceof Error) throw next;
			return {
				name,
				async createToken(scope, ttl) {
					tokens.push([scope, ttl]);
					return {
						id: 'token-id',
						plaintext: 'art_v2_write?expires=1',
						scope: 'write',
						expiresAt: '2026-10-14T01:00:00.000Z',
					};
				},
			} as ArtifactsRepo;
		},
		async create(name, opts) {
			calls.push(`create ${name} ${JSON.stringify(opts)}`);
			const next = creates.shift();
			if (next instanceof Error) throw next;
			return {
				name,
				token: 'art_v2_create?expires=1',
			} as ArtifactsCreateRepoResult;
		},
	};
	const store = createArtifactsRepositoryStore({
		artifacts,
		accountId: 'account123',
		namespace: 'epicenter-test',
	});
	return { store, calls, tokens };
}

test('an existing repository gets a fresh one-hour write token', async () => {
	const { store, calls, tokens } = scripted(['found']);
	expect(await store.connect(alice, 'so.epicenter.todos')).toEqual({
		name: REPOSITORY,
		token: 'art_v2_write?expires=1',
		expiresAt: '2026-10-14T01:00:00.000Z',
	});
	expect(calls).toEqual([`get ${REPOSITORY}`]);
	expect(tokens).toEqual([['write', 3600]]);
});

test('a missing repository is created on main, then minted its own token', async () => {
	const { store, calls } = scripted(['missing', 'found'], ['created']);
	const repository = await store.connect(alice, 'so.epicenter.todos');
	expect(repository.token).toBe('art_v2_write?expires=1');
	expect(calls).toEqual([
		`get ${REPOSITORY}`,
		`create ${REPOSITORY} {"setDefaultBranch":"main"}`,
		`get ${REPOSITORY}`,
	]);
});

test('missing and existing repositories are recognized by message when the RPC drops the code', async () => {
	// As the binding's error arrived in a deployed Worker on 2026-10-14.
	const missing = new Error(`ArtifactsError: Repository not found: ${REPOSITORY}.`);
	const exists = new Error(`ArtifactsError: repo already exists: ${REPOSITORY}`);
	const { store, calls } = scripted([missing, 'found'], [exists]);
	expect((await store.connect(alice, 'so.epicenter.todos')).name).toBe(
		REPOSITORY,
	);
	expect(calls).toHaveLength(3);
});

test('losing a create race reads the repository the other connect made', async () => {
	const { store, calls } = scripted(
		['missing', 'found'],
		[artifactsError('ALREADY_EXISTS')],
	);
	expect((await store.connect(alice, 'so.epicenter.todos')).name).toBe(
		REPOSITORY,
	);
	expect(calls).toHaveLength(3);
});

test('other binding failures propagate instead of reading as missing', async () => {
	const internal = artifactsError('INTERNAL_ERROR');
	await expect(
		scripted([internal]).store.connect(alice, 'so.epicenter.todos'),
	).rejects.toBe(internal);
	const plain = new Error('binding unreachable');
	await expect(
		scripted([plain]).store.connect(alice, 'so.epicenter.todos'),
	).rejects.toBe(plain);
	const invalid = artifactsError('INVALID_REPO_NAME');
	const { store, calls } = scripted(['missing'], [invalid]);
	await expect(store.connect(alice, 'so.epicenter.todos')).rejects.toBe(
		invalid,
	);
	expect(calls).toHaveLength(2);
});

test('different principals get different repositories for one folder', async () => {
	const { store } = scripted(['found', 'found']);
	const a = await store.connect(alice, 'so.epicenter.todos');
	const b = await store.connect(asPrincipalId('bob'), 'so.epicenter.todos');
	expect(a.name).not.toBe(b.name);
	expect(b.name).toMatch(/^so\.epicenter\.todos\.[0-9a-f]{16}$/);
});

test('serving forwards to the derived Artifacts URL without following redirects', async () => {
	const requests: { url: string; init: RequestInit }[] = [];
	globalThis.fetch = (async (
		url: string | URL | Request,
		init?: RequestInit,
	) => {
		requests.push({ url: String(url), init: init! });
		return new Response('ok');
	}) as typeof fetch;
	const { store, calls } = scripted([]);
	const headers = new Headers({ authorization: 'Basic eDp5' });
	const signal = new AbortController().signal;
	await store.serve(REPOSITORY, {
		service: 'git-upload-pack',
		advertisement: true,
		headers,
		body: null,
		signal,
	});
	const body = new Blob(['pack']).stream();
	await store.serve(REPOSITORY, {
		service: 'git-receive-pack',
		advertisement: false,
		headers,
		body,
		signal,
	});
	expect(requests.map(({ url, init }) => [init.method, url])).toEqual([
		[
			'GET',
			`https://account123.artifacts.cloudflare.net/git/epicenter-test/${REPOSITORY}.git/info/refs?service=git-upload-pack`,
		],
		[
			'POST',
			`https://account123.artifacts.cloudflare.net/git/epicenter-test/${REPOSITORY}.git/git-receive-pack`,
		],
	]);
	for (const { init } of requests) {
		expect(init.redirect).toBe('manual');
		expect(init.headers).toBe(headers);
		expect(init.signal).toBe(signal);
	}
	expect(requests[1]!.init.body).toBe(body);
	expect(calls).toEqual([]);
});

test('the namespace var names the same namespace as the Artifacts binding', async () => {
	const config = Bun.JSONC.parse(
		await Bun.file(new URL('../wrangler.jsonc', import.meta.url)).text(),
	) as {
		vars: Record<string, string>;
		artifacts: { binding: string; namespace: string }[];
		secrets: { required: string[] };
	};
	const binding = config.artifacts.find(
		({ binding }) => binding === 'ARTIFACTS',
	);
	expect(binding?.namespace).toBe(config.vars.ARTIFACTS_NAMESPACE!);
	expect(config.secrets.required).toContain('ARTIFACTS_ACCOUNT_ID');
});
