import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
export default defineConfig({
	plugins: [
		cloudflareTest({
			main: './evidence/enrollment/admission.ts',
			miniflare: {
				compatibilityDate: '2026-03-06',
				compatibilityFlags: ['nodejs_compat'],
				durableObjects: {
					ENROLLMENT: { className: 'EnrollmentAdmission', useSQLite: true },
				},
			},
		}),
	],
	test: {
		include: ['evidence/enrollment/admission.worker.ts'],
		testTimeout: 30_000,
	},
});
