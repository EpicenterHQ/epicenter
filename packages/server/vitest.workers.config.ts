/**
 * The store transport's route and authority, in `workerd`.
 *
 * `bun test` cannot run either: a Durable Object is a `workerd` construct, and
 * the authority IS one. This is the only configuration in this package that
 * runs the real runtime, and it mounts the deployed route and the deployed
 * Durable Object with one substitution, the bearer resolver.
 */
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { kCurrentWorker } from 'miniflare';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		cloudflareTest({
			main: './workers/entry.ts',
			miniflare: {
				compatibilityDate: '2026-03-06',
				compatibilityFlags: ['nodejs_compat'],
				bindings: {
					BLOBS_S3_ENDPOINT: 'https://attachment-store.test',
					BLOBS_S3_ACCESS_KEY_ID: 'test-access',
					BLOBS_S3_SECRET_ACCESS_KEY: 'test-secret',
					BLOBS_S3_BUCKET: 'test-bucket',
				},
				durableObjects: {
					STORE_AUTHORITY: {
						className: 'StoreAuthority',
						useSQLite: true,
					},
					GENERATIONS_LEDGER: {
						className: 'GenerationsLedger',
						useSQLite: true,
					},
					REPLICA: { className: 'StoreTestReplica', useSQLite: true },
				},
				// The replicas dial the route through the worker itself, which is
				// how a browser reaches it: one origin, one Hono app, the real mount
				// and the real bearer gate. `SELF` from `cloudflare:test` is injected
				// into the TEST, not into a Durable Object, so a replica needs this.
				serviceBindings: { SELF: kCurrentWorker },
			},
		}),
	],
	test: { include: ['workers/**/*.test.ts'], testTimeout: 30_000 },
});
