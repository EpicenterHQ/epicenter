/**
 * The dashboard command selects localhost:5178, and the development launcher
 * accepts only loopback origins before it starts its build and secret tools.
 */
import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { localPublicOrigin } from './dev-config.ts';

test('dashboard startup supplies its public origin without changing ordinary API startup', async () => {
	const { scripts } = await Bun.file(
		new URL('../../../package.json', import.meta.url),
	).json();
	expect(scripts['dev:api-dashboard']).toBe(
		'API_PUBLIC_ORIGIN=http://localhost:5178 bun run --filter @epicenter/api --filter @epicenter/api-ui dev',
	);
	expect(scripts['dev:api']).toBe('bun run --cwd apps/api dev');
});

test('local issuer accepts only complete HTTP loopback origins', () => {
	expect(localPublicOrigin(undefined)).toBe('http://localhost:8787');
	for (const origin of [
		'http://localhost:5178',
		'http://127.0.0.1:8787',
		'http://[::1]:8787',
	])
		expect(localPublicOrigin(origin)).toBe(origin);
	for (const origin of [
		'https://localhost:5178',
		'http://api.epicenter.so',
		'http://0.0.0.0:8787',
		'http://127.0.0.2:8787',
		'http://localhost:5178/path',
		'http://localhost:5178?query=1',
		'http://localhost:5178/',
	])
		expect(() => localPublicOrigin(origin)).toThrow(
			'API_PUBLIC_ORIGIN must be an HTTP loopback origin for local dev.',
		);
});

test('the launcher rejects an unsafe origin before starting its tools', async () => {
	const child = Bun.spawn(
		[process.execPath, fileURLToPath(new URL('./dev.ts', import.meta.url))],
		{
			env: { ...process.env, API_PUBLIC_ORIGIN: 'https://api.epicenter.so' },
			stdout: 'ignore',
			stderr: 'pipe',
		},
	);
	const stderr = await new Response(child.stderr).text();
	expect(await child.exited).not.toBe(0);
	expect(stderr).toContain(
		'API_PUBLIC_ORIGIN must be an HTTP loopback origin for local dev.',
	);
});
