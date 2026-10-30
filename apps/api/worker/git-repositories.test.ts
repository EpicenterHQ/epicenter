/**
 * The Artifacts Git store against a scripted binding and a stubbed `fetch`.
 * The binding has no local emulation, so these pin the calls the store makes:
 * the create it absorbs, the tokens it mints and caches, and the exact
 * upstream request.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
	type ArtifactsNamespace,
	createArtifactsGitHost,
	resolveArtifactsGitHost,
} from './git-repositories.js';

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const ID = '0123456789abcdef';

function artifactsError(code: ArtifactsErrorCode) {
	return Object.assign(new Error(code), { name: 'ArtifactsError', code });
}

function scripted(
	creates: ('created' | Error)[] = [],
	{ receiver = false }: { receiver?: boolean } = {},
) {
	const calls: string[] = [];
	const minted: [string | undefined, number | undefined][] = [];
	let serial = 0;
	const artifacts: ArtifactsNamespace = {
		async get(name) {
			calls.push(`get ${name}`);
			return {
				name,
				async createToken(scope, ttl) {
					minted.push([scope, ttl]);
					serial++;
					return {
						id: `token-${serial}`,
						plaintext: `art_v2_${scope}_${serial}?expires=1`,
						scope,
						expiresAt: '2026-10-15T01:00:00.000Z',
					};
				},
			} as ArtifactsRepo;
		},
		async create(name, opts) {
			calls.push(`create ${name} ${JSON.stringify(opts)}`);
			const next = creates.shift();
			if (next instanceof Error) throw next;
			return { name, token: 'ignored' } as ArtifactsCreateRepoResult;
		},
		async delete(name) {
			calls.push(`delete ${name}`);
			return true;
		},
	};
	let clock = 0;
	const host = createArtifactsGitHost({
		artifacts,
		accountId: 'account123',
		namespace: 'epicenter-test',
		receiver,
		now: () => clock,
	});
	return {
		host,
		calls,
		minted,
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

function stubFetch(answer: () => Response = () => new Response('ok')) {
	const requests: { url: string; init: RequestInit }[] = [];
	globalThis.fetch = (async (
		url: string | URL | Request,
		init?: RequestInit,
	) => {
		requests.push({ url: String(url), init: init! });
		return answer();
	}) as typeof fetch;
	return requests;
}

const request = (
	service: 'git-upload-pack' | 'git-receive-pack',
	advertisement: boolean,
	body: ReadableStream<Uint8Array> | null = null,
) => ({
	service,
	advertisement,
	headers: new Headers({
		'content-type': 'x-git',
		authorization: 'Bearer client',
	}),
	body,
	signal: new AbortController().signal,
	accountId: 'account',
});

test('a repository is created by its id on main, and one that exists is not an error', async () => {
	const { host, calls } = scripted(['created']);
	await host.create(ID);
	expect(calls).toEqual([`create ${ID} {"setDefaultBranch":"main"}`]);
	const lost = scripted([artifactsError('ALREADY_EXISTS')]);
	await lost.host.create(ID);
	// As the binding's error arrived in a deployed Worker on 2026-10-14.
	const byMessage = scripted([
		new Error(`ArtifactsError: repo already exists: ${ID}`),
	]);
	await byMessage.host.create(ID);
});

test('other binding failures propagate', async () => {
	const internal = artifactsError('INTERNAL_ERROR');
	await expect(scripted([internal]).host.create(ID)).rejects.toBe(internal);
	const plain = new Error('binding unreachable');
	await expect(scripted([plain]).host.create(ID)).rejects.toBe(plain);
});

test('serving forwards to the id URL with a minted token, never the client credential', async () => {
	const requests = stubFetch();
	const { host } = scripted();
	await host.serve(ID, request('git-upload-pack', true));
	const body = new Blob(['pack']).stream();
	await host.serve(ID, request('git-receive-pack', false, body));
	expect(requests.map(({ url, init }) => [init.method, url])).toEqual([
		[
			'GET',
			`https://account123.artifacts.cloudflare.net/git/epicenter-test/${ID}.git/info/refs?service=git-upload-pack`,
		],
		[
			'POST',
			`https://account123.artifacts.cloudflare.net/git/epicenter-test/${ID}.git/git-receive-pack`,
		],
	]);
	const [read, write] = requests.map(({ init }) =>
		new Headers(init.headers).get('authorization'),
	);
	expect(read).toBe(`Basic ${btoa('x:art_v2_read_1?expires=1')}`);
	expect(write).toBe(`Basic ${btoa('x:art_v2_write_2?expires=1')}`);
	for (const { init } of requests) expect(init.redirect).toBe('manual');
	expect(requests[1]?.init.body).toBe(body);
});

test('a token is minted for 24 hours per repository and scope, cached, and renewed an hour early', async () => {
	stubFetch();
	const { host, minted, advance } = scripted();
	await host.serve(ID, request('git-upload-pack', true));
	await host.serve(ID, request('git-upload-pack', false));
	await host.serve(ID, request('git-receive-pack', true));
	expect(minted).toEqual([
		['read', 86_400],
		['write', 86_400],
	]);
	advance(22 * 60 * 60 * 1000);
	await host.serve(ID, request('git-upload-pack', true));
	expect(minted).toHaveLength(2);
	advance(60 * 60 * 1000);
	await host.serve(ID, request('git-upload-pack', true));
	expect(minted).toHaveLength(3);
	await host.serve('fedcba9876543210', request('git-upload-pack', true));
	expect(minted).toHaveLength(4);
});

test('a token Artifacts refuses is dropped, so the next request mints another', async () => {
	let status = 401;
	globalThis.fetch = (async () =>
		new Response(null, { status })) as unknown as typeof fetch;
	const { host, minted } = scripted();
	expect((await host.serve(ID, request('git-upload-pack', true))).status).toBe(
		401,
	);
	status = 200;
	await host.serve(ID, request('git-upload-pack', true));
	await host.serve(ID, request('git-upload-pack', true));
	expect(minted).toHaveLength(2);
});

test('a delete removes the repository by its id and drops its cached tokens', async () => {
	stubFetch();
	const { host, calls, minted } = scripted();
	await host.serve(ID, request('git-upload-pack', true));
	await host.serve(ID, request('git-receive-pack', true));
	await host.delete(ID);
	expect(calls).toContain(`delete ${ID}`);
	// The deleted repository's tokens are not kept.
	await host.serve(ID, request('git-upload-pack', true));
	await host.serve(ID, request('git-receive-pack', true));
	expect(minted).toHaveLength(4);
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

describe('the receiver waits for an R2 LFS store', () => {
	const pkt = (line: string) =>
		`${(line.length + 4).toString(16).padStart(4, '0')}${line}`;
	const advertisement = () =>
		new Response(
			[
				pkt('# service=git-upload-pack\n'),
				'0000',
				pkt(`${'a'.repeat(40)} HEAD\0multi_ack\n`),
				pkt(`${'b'.repeat(40)} refs/epicenter/captures/cap-1\n`),
				pkt(`${'a'.repeat(40)} refs/heads/main\n`),
				'0000',
			].join(''),
		);
	const withProtocol = () => {
		const sent = request('git-upload-pack', true);
		sent.headers.set('git-protocol', 'version=2');
		return sent;
	};

	test('without one, the host has no objects and proxies every Git request as before the receiver', async () => {
		const requests = stubFetch(advertisement);
		const { host } = scripted([], { receiver: false });
		expect(host.objects).toBeUndefined();
		const served = await host.serve(ID, withProtocol());
		// Protocol v2 is asked for, and the advertisement comes back untouched.
		expect(new Headers(requests[0]?.init.headers).get('git-protocol')).toBe(
			'version=2',
		);
		expect(await served.text()).toBe(await advertisement().text());
	});

	test('with one, pushes and web writes go through the receiver, and receipt refs are hidden', async () => {
		const requests = stubFetch(advertisement);
		const { host } = scripted([], { receiver: true });
		expect(host.objects).toBeFunction();
		const served = await host.serve(ID, withProtocol());
		expect(new Headers(requests[0]?.init.headers).get('git-protocol')).toBe(
			null,
		);
		expect(await served.text()).not.toContain('refs/epicenter/captures/');
	});

	test('the deployment gets the receiver only when every R2 LFS binding is there', () => {
		const artifacts = {} as ArtifactsNamespace;
		const base = {
			ARTIFACTS: artifacts,
			ARTIFACTS_ACCOUNT_ID: 'account123',
			ARTIFACTS_NAMESPACE: 'epicenter-test',
		};
		const lfs = {
			LFS_BUCKET: {} as never,
			LFS_BUCKET_NAME: 'epicenter-lfs',
			R2_ACCESS_KEY_ID: 'key',
			R2_SECRET_ACCESS_KEY: 'secret',
		};
		expect(resolveArtifactsGitHost({})).toBeNull();
		// Production today: Artifacts bound, no LFS bucket.
		expect(resolveArtifactsGitHost(base)?.objects).toBeUndefined();
		for (const missing of Object.keys(lfs)) {
			const partial = { ...base, ...lfs, [missing]: undefined };
			expect(resolveArtifactsGitHost(partial)?.objects).toBeUndefined();
		}
		expect(
			resolveArtifactsGitHost({ ...base, ...lfs })?.objects,
		).toBeFunction();
	});
});
