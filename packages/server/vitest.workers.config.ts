/**
 * Tests that need `workerd`: the folder MCP server's code against a Worker
 * runtime. Each test builds its own app.
 */
import { createRequire } from 'node:module';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: {
			// The Worker pool loads pg through require; Vite 8 otherwise selects
			// pg-protocol's import entry and hands ESM to its CommonJS loader.
			'pg-protocol': createRequire(import.meta.resolve('pg')).resolve(
				'pg-protocol',
			),
		},
	},
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
			},
		}),
	],
	test: {
		include: ['workers/**/*.test.ts'],
		testTimeout: 30_000,
	},
});
