import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
export default defineConfig({
	plugins: [
		cloudflareTest({
			main: './evidence/enrollment/production-entry.ts',
			miniflare: {
				compatibilityDate: '2026-03-06',
				compatibilityFlags: ['nodejs_compat'],
				bindings: {
					API_PUBLIC_ORIGIN: 'https://enrollment.example.test',
					SELF_HOST_CALLBACKS: '["https://notes.example.test/auth/callback"]',
				},
				durableObjects: {
					SELF_HOST_AUTH: { className: 'SelfHostAuthOwner', useSQLite: true },
				},
			},
		}),
	],
	test: {
		include: ['evidence/enrollment/production.worker.ts'],
		testTimeout: 30_000,
	},
});
