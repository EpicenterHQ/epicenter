/**
 * The dashboard command selects localhost:5178, and the development launcher
 * accepts only loopback origins before it starts its build and secret tools.
 * With a valid origin, it removes production routes from the Wrangler config
 * passed to local development and cleans up generated files.
 */
import { expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localPublicOrigin } from './dev-config.ts';

setDefaultTimeout(20_000);

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

test('the launcher passes a route-free local config to Wrangler', async () => {
	const root = await mkdtemp(join(import.meta.dir, '..', '.dev-test-'));
	try {
		const api = join(root, 'api');
		const scripts = join(api, 'scripts');
		const bin = join(root, 'bin');
		const captured = join(root, 'captured.json');
		const argumentsFile = join(root, 'arguments.txt');
		const buildArguments = join(root, 'build-arguments.txt');
		const generated = join(api, 'wrangler.dev.generated.json');
		const devVars = join(api, '.dev.vars');
		await mkdir(scripts, { recursive: true });
		await mkdir(bin);
		for (const name of ['dev.ts', 'dev-config.ts'])
			await writeFile(
				join(scripts, name),
				await readFile(new URL(`./${name}`, import.meta.url), 'utf8'),
			);
		await writeFile(
			join(api, 'wrangler.jsonc'),
			await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'),
		);
		await writeFile(devVars, 'stale-local-secret\n');
		await writeFile(
			join(bin, 'bun'),
			'#!/bin/sh\nprintf "%s\\n" "$@" > "$BUILD_ARGUMENTS"\n',
			{ mode: 0o755 },
		);
		await writeFile(
			join(bin, 'infisical'),
			'#!/bin/sh\nif [ "$1" = "--silent" ] && [ "$2" = "user" ] && [ "$3" = "get" ]; then printf "test-token\\n"; exit 0; fi\nprintf "%s\\n" "$@" > "$DEV_ARGUMENTS"\ncp wrangler.dev.generated.json "$DEV_CAPTURE"\n',
			{ mode: 0o755 },
		);
		const child = Bun.spawn([process.execPath, join(scripts, 'dev.ts')], {
			cwd: api,
			env: {
				...process.env,
				PATH: `${bin}:${process.env.PATH ?? ''}`,
				API_PUBLIC_ORIGIN: 'http://localhost:5178',
				BUILD_ARGUMENTS: buildArguments,
				DEV_ARGUMENTS: argumentsFile,
				DEV_CAPTURE: captured,
			},
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
		});
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, 10_000);
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		clearTimeout(timer);
		if (timedOut)
			throw new Error(`dev launcher timed out: ${stdout}\n${stderr}`);
		expect(code).toBe(0);
		expect(await readFile(buildArguments, 'utf8')).toBe(
			'run\n--cwd\nui\nbuild\n',
		);
		const original = Bun.JSONC.parse(
			await readFile(join(api, 'wrangler.jsonc'), 'utf8'),
		) as Record<string, unknown>;
		const local = JSON.parse(await readFile(captured, 'utf8')) as Record<
			string,
			unknown
		>;
		expect(original.routes).toEqual([
			{ pattern: 'api.epicenter.so', custom_domain: true },
		]);
		expect(local).toEqual({ ...original, routes: [] });
		expect(await readFile(argumentsFile, 'utf8')).toBe(
			`run\n--silent\n--env=dev\n--path=/api\n--\nbun\nx\nwrangler\ndev\n--config\n${generated}\n--var\nAPI_PUBLIC_ORIGIN:http://localhost:5178\n`,
		);
		expect(await Bun.file(generated).exists()).toBe(false);
		expect(await Bun.file(devVars).exists()).toBe(false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
