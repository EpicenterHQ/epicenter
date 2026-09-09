import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { kCurrentWorker } from 'miniflare';
import { defineConfig } from 'vitest/config';
export default defineConfig({
	plugins: [
		cloudflareTest({
			main: '../../apps/self-host/worker/index.ts',
			miniflare: {
				compatibilityDate: '2026-03-06',
				compatibilityFlags: ['nodejs_compat'],
				bindings: {
					API_PUBLIC_ORIGIN: 'https://enrollment.example.test',
					SELF_HOST_CALLBACKS: '["https://notes.example.test/auth/callback"]',
					TRUSTED_BROWSER_ORIGINS: 'https://notes.example.test',
				},
				serviceBindings: {
					OPERATOR: { name: kCurrentWorker, entrypoint: 'SelfHostOperator' },
				},
				durableObjects: {
					SELF_HOST_AUTH: { className: 'SelfHostAuthOwner', useSQLite: true },
					STORE_AUTHORITY: { className: 'StoreAuthority', useSQLite: true },
					GENERATIONS_LEDGER: {
						className: 'GenerationsLedger',
						useSQLite: true,
					},
				},
			},
		}),
	],
	test: {
		include: ['evidence/enrollment/production.worker.ts'],
		testTimeout: 30_000,
	},
});
