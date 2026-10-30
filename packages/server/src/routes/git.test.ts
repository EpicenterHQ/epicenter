/**
 * `mountGitHost` without Postgres, over an injected `GitAccess`: what a
 * store without `objects` answers. Such a store (the hosted cloud's
 * Artifacts host until an R2 LFS bucket is bound) must answer exactly as
 * hosted Git did before the receiver (`75a0788dd4`): Git's smart HTTP under
 * a named namespace, proxied to the store, and 404 for every other path,
 * except that only the owner may push, since nothing would stop a push
 * replacing `main`. The full routes against Postgres and the disk store are in
 * `git.postgres.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { resolveOAuthAudiences } from '@epicenter/constants/apps';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { RepositoryRole } from '../namespace-roles.js';
import type { CloudEnv } from '../types.js';
import { type GitAccess, type GitHost, mountGitHost } from './git.js';

const NAMESPACE = 'abcdefghijkl';
const BASE = `http://localhost:8787/git/${NAMESPACE}/notes.git`;

function mount({
	host = 'objectless',
	role = 'owner',
}: {
	host?: 'objectless' | 'none';
	role?: RepositoryRole;
} = {}) {
	const served: string[] = [];
	const access: GitAccess = {
		async authorize(_c, { namespaceId }) {
			return {
				data: {
					accountId: 'account',
					role,
					namespaceId,
					repository: { id: 'repo1' },
				},
				error: null,
			};
		},
		async create() {
			return { id: 'repo1' };
		},
	};
	const store: GitHost = {
		async serve(id, { service, advertisement }) {
			served.push(`${id} ${service} ${advertisement}`);
			return new Response('from the store');
		},
		async create() {},
		async delete() {},
	};
	const app = new Hono<CloudEnv>();
	app.use('*', async (c, next) => {
		c.set('audiences', resolveOAuthAudiences(new URL(c.req.url).origin));
		await next();
	});
	mountGitHost(app, {
		setup: createMiddleware<CloudEnv>(async (_c, next) => next()),
		access,
		resolveHost: () => (host === 'none' ? null : store),
	});
	return { app, served };
}

/** What `75a0788dd4` answered for any path it did not route. */
const NOT_ROUTED = {
	error: 'not_found',
	error_description: 'Not a Git request this server answers.',
};

describe('a store without objects answers as hosted Git did before the receiver', () => {
	test("Git's smart HTTP goes to the store, pushes included", async () => {
		const { app, served } = mount();
		for (const [method, path] of [
			['GET', '/info/refs?service=git-upload-pack'],
			['GET', '/info/refs?service=git-receive-pack'],
			['POST', '/git-upload-pack'],
			['POST', '/git-receive-pack'],
		] as const) {
			const response = await app.request(`${BASE}${path}`, {
				method,
				body: method === 'POST' ? 'pack' : undefined,
			});
			expect(await response.text()).toBe('from the store');
		}
		expect(served).toEqual([
			'repo1 git-upload-pack true',
			'repo1 git-receive-pack true',
			'repo1 git-upload-pack false',
			'repo1 git-receive-pack false',
		]);
	});

	test('LFS, the write translator and the personal namespace are not routed', async () => {
		for (const host of ['objectless', 'none'] as const) {
			const { app, served } = mount({ host });
			for (const [method, url] of [
				['POST', `${BASE}/info/lfs/objects/batch`],
				['POST', `${BASE}/info/lfs/verify`],
				['GET', `${BASE}/info/lfs/locks`],
				['PUT', `${BASE}/info/lfs/objects/${'a'.repeat(64)}`],
				['GET', `${BASE}/epicenter/files`],
				['GET', `${BASE}/epicenter/file?path=a.md`],
				['POST', `${BASE}/epicenter/writes`],
				[
					'GET',
					'http://localhost:8787/git/~/notes.git/info/refs?service=git-upload-pack',
				],
			] as const) {
				const response = await app.request(url, {
					method,
					body: method === 'GET' ? undefined : '{}',
				});
				expect([url, response.status]).toEqual([url, 404]);
				expect((await response.json()) as unknown).toEqual(NOT_ROUTED);
			}
			expect(served).toEqual([]);
		}
	});

	test('a role that may not rewrite main reads, but may not push', async () => {
		for (const role of ['member', 'writer'] as const) {
			const { app, served } = mount({ role });
			const read = await app.request(
				`${BASE}/info/refs?service=git-upload-pack`,
			);
			expect(await read.text()).toBe('from the store');
			for (const [method, path] of [
				['GET', '/info/refs?service=git-receive-pack'],
				['POST', '/git-receive-pack'],
			] as const) {
				const response = await app.request(`${BASE}${path}`, {
					method,
					body: method === 'POST' ? 'pack' : undefined,
				});
				expect([role, path, response.status]).toEqual([role, path, 403]);
			}
			expect(served).toEqual(['repo1 git-upload-pack true']);
		}
	});
});
