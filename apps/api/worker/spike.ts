/**
 * The Cloudflare spike Worker (decision 48, phase 7): hosted Git, the web
 * write translator, the push receiver and Git LFS from `@epicenter/server`,
 * over Artifacts and R2, exactly as `mountGitHost` serves them on the hosted
 * cloud. Only the access differs: two bearer tokens stand in for the OAuth
 * server, which needs a database this Worker does not have.
 *
 * ```txt
 * <origin>/git/<namespace|~>/<name>.git/...   mountGitHost: Git, epicenter/{files,file,writes}, info/lfs
 * <origin>/admin/...                          owner token only: the spike's own inspection and cleanup
 * ```
 *
 * - `SPIKE_OWNER_TOKEN` acts as the namespace's owner (may rewrite `main`),
 *   `SPIKE_MEMBER_TOKEN` as a member. Either goes as a Bearer token or as the
 *   password of Basic credentials, so stock `git` and `git lfs` use it through
 *   a credential helper.
 * - There is one namespace, `SPIKE_NAMESPACE`; `~` resolves to it.
 * - A repository's Artifacts name is `SPIKE_REPOSITORY_PREFIX` plus its name.
 *   Its first write creates it, as on the hosted cloud.
 *
 * Deploy only with `wrangler deploy --config wrangler.spike.jsonc`.
 */
import { resolveOAuthAudiences } from '@epicenter/constants/apps';
import {
	type CloudEnv,
	type GitAccess,
	mountGitHost,
	readAccessToken,
} from '@epicenter/server';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { createArtifactsGitHost } from './git-repositories.js';
import { type LfsBindings, resolveR2Lfs } from './lfs-store.js';

type SpikeEnv = LfsBindings & {
	ARTIFACTS: Artifacts;
	ARTIFACTS_ACCOUNT_ID: string;
	ARTIFACTS_NAMESPACE: string;
	LFS_BUCKET: R2Bucket;
	SPIKE_NAMESPACE: string;
	SPIKE_REPOSITORY_PREFIX: string;
	SPIKE_OWNER_TOKEN: string;
	SPIKE_MEMBER_TOKEN: string;
};

const spikeEnv = (env: CloudEnv['Bindings']) => env as unknown as SpikeEnv;

/** Equal strings, compared in time that does not depend on where they differ. */
function same(a: string, b: string): boolean {
	if (a.length !== b.length || b.length === 0) return false;
	let difference = 0;
	for (let at = 0; at < a.length; at++)
		difference |= a.charCodeAt(at) ^ b.charCodeAt(at);
	return difference === 0;
}

function roleOf(env: SpikeEnv, authorization: string | undefined) {
	const token = readAccessToken(authorization);
	if (token === null) return null;
	if (same(token, env.SPIKE_OWNER_TOKEN)) return 'owner' as const;
	if (same(token, env.SPIKE_MEMBER_TOKEN)) return 'member' as const;
	return null;
}

/** Repositories this isolate has seen exist, so each is looked up once. */
const known = new Set<string>();

async function exists(env: SpikeEnv, id: string): Promise<boolean> {
	if (known.has(id)) return true;
	try {
		const repository = await env.ARTIFACTS.get(id);
		(repository as { [Symbol.dispose]?(): void })[Symbol.dispose]?.();
	} catch (cause) {
		const { code, message } = cause as { code?: string; message?: string };
		if (code === 'NOT_FOUND' || /not found/i.test(message ?? '')) return false;
		throw cause;
	}
	known.add(id);
	return true;
}

const challenge = 'Bearer realm="epicenter-spike8"';

const spikeAccess: GitAccess = {
	async authorize(c, { namespaceId, name }) {
		const env = spikeEnv(c.env);
		const role = roleOf(env, c.req.header('authorization'));
		if (role === null)
			return {
				data: null,
				error: {
					status: 401,
					challenge,
					body: {
						error: 'invalid_token',
						error_description: 'Send a spike token.',
					},
				},
			};
		const namespace = namespaceId === '~' ? env.SPIKE_NAMESPACE : namespaceId;
		if (namespace !== env.SPIKE_NAMESPACE)
			return {
				data: null,
				error: {
					status: 403,
					challenge,
					body: {
						error: 'forbidden',
						error_description: `This spike hosts only ${env.SPIKE_NAMESPACE}.`,
					},
				},
			};
		const id = `${env.SPIKE_REPOSITORY_PREFIX}${name}`;
		return {
			data: {
				accountId: role,
				role,
				namespaceId: namespace,
				repository: (await exists(env, id)) ? { id } : null,
			},
			error: null,
		};
	},
	async create(c, { name, host }) {
		const env = spikeEnv(c.env);
		const id = `${env.SPIKE_REPOSITORY_PREFIX}${name}`;
		await host.create(id);
		known.add(id);
		return { id };
	},
};

const app = new Hono<CloudEnv>();

// The deployment's audiences: Git at `<origin>/git`, as for any origin but
// the hosted cloud's.
app.use('*', async (c, next) => {
	c.set('audiences', resolveOAuthAudiences(new URL(c.req.url).origin));
	await next();
});

mountGitHost(app, {
	setup: createMiddleware<CloudEnv>(async (_c, next) => next()),
	access: spikeAccess,
	resolveHost: (bindings) => {
		const env = spikeEnv(bindings);
		return createArtifactsGitHost({
			artifacts: env.ARTIFACTS,
			accountId: env.ARTIFACTS_ACCOUNT_ID,
			namespace: env.ARTIFACTS_NAMESPACE,
		});
	},
	resolveLfs: (bindings) => resolveR2Lfs(spikeEnv(bindings)),
});

// The spike's own inspection and cleanup, for the owner token only.
const owner = createMiddleware<CloudEnv>(async (c, next) => {
	if (roleOf(spikeEnv(c.env), c.req.header('authorization')) !== 'owner')
		return c.json({ error: 'owner token required' }, 401);
	await next();
});

app.get('/admin/repos', owner, async (c) =>
	c.json(await spikeEnv(c.env).ARTIFACTS.list({ limit: 200 })),
);

app.get('/admin/r2/list', owner, async (c) => {
	const bucket = spikeEnv(c.env).LFS_BUCKET;
	const objects: { key: string; size: number }[] = [];
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ cursor, limit: 1000 });
		objects.push(...page.objects.map(({ key, size }) => ({ key, size })));
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return c.json({ count: objects.length, objects });
});

app.post('/admin/r2/wipe', owner, async (c) => {
	const bucket = spikeEnv(c.env).LFS_BUCKET;
	let deleted = 0;
	for (;;) {
		const page = await bucket.list({ limit: 1000 });
		if (page.objects.length === 0) break;
		await bucket.delete(page.objects.map((o) => o.key));
		deleted += page.objects.length;
	}
	return c.json({
		deleted,
		remaining: (await bucket.list({ limit: 1 })).objects.length,
	});
});

/** How the binding answers what the code assumes: a missing object, and `log`. */
app.get('/admin/probe', owner, async (c) => {
	const env = spikeEnv(c.env);
	const id = `${env.SPIKE_REPOSITORY_PREFIX}${c.req.query('name') ?? ''}`;
	const repository = (await env.ARTIFACTS.get(id)) as unknown as Record<
		string,
		(...args: unknown[]) => Promise<unknown>
	>;
	const attempt = async (call: () => Promise<unknown>) => {
		const started = Date.now();
		try {
			return { value: await call(), ms: Date.now() - started };
		} catch (cause) {
			const { code, message } = cause as { code?: string; message?: string };
			return { thrown: { code, message }, ms: Date.now() - started };
		}
	};
	const missing = 'f'.repeat(40);
	return c.json({
		methods: Object.keys(Object.getPrototypeOf(repository) ?? {}),
		readCommitMissing: await attempt(
			() => repository.readCommit?.(missing) ?? Promise.resolve('no method'),
		),
		readBlobMissing: await attempt(
			() => repository.readBlob?.(missing) ?? Promise.resolve('no method'),
		),
		log: await attempt(
			() =>
				repository.log?.({ ref: 'main', limit: 3 }) ??
				Promise.resolve('no method'),
		),
	});
});

app.get('/', (c) =>
	c.json({
		spike: 'epicenter-spike8',
		git: `${new URL(c.req.url).origin}/git`,
	}),
);

export default app;
