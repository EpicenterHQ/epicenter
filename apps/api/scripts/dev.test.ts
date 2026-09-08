/**
 * Dashboard startup keeps the browser and public issuer on localhost:5178.
 * These source-boundary checks never import or execute the dev launcher, which
 * builds assets, removes stale secrets files, and invokes Infisical.
 */
import { expect, test } from 'bun:test';
import { buildSessionCallbacks } from '../worker/session-callbacks.js';

test('dashboard startup supplies its public origin without changing ordinary API startup', async () => {
	const { scripts } = await Bun.file(
		new URL('../../../package.json', import.meta.url),
	).json();
	expect(scripts['dev:api-dashboard']).toBe(
		'API_PUBLIC_ORIGIN=http://localhost:5178 bun run --filter @epicenter/api --filter @epicenter/api-ui dev',
	);
	expect(scripts['dev:api']).toBe('bun run --cwd apps/api dev');
	expect(buildSessionCallbacks('http://localhost:5178')).toContain(
		'http://localhost:5178/session/callback',
	);
});

test('dev launcher forwards the loopback override after validating it before side effects', async () => {
	const source = await Bun.file(new URL('./dev.ts', import.meta.url)).text();
	expect(source).toContain(
		'const publicOrigin = process.env.API_PUBLIC_ORIGIN ?? localUrl(APPS.API);',
	);
	expect(source).toContain("publicUrl.protocol !== 'http:'");
	expect(source).toContain(
		"!['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname)",
	);
	expect(source).toContain('publicUrl.origin !== publicOrigin');
	const rejection = source.indexOf('throw new Error(');
	expect(rejection).toBeGreaterThan(-1);
	expect(rejection).toBeLessThan(source.indexOf('await mkdir('));
	expect(source).toContain('API_PUBLIC_ORIGIN:${publicOrigin}');
});
