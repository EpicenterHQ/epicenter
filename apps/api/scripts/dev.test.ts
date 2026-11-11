/**
 * The local API launcher rejects unsafe public origins before side effects and
 * removes production-only Wrangler bindings from its generated dev config.
 */
import { expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

setDefaultTimeout(20_000);

test('dashboard startup supplies its public origin without changing ordinary API startup', async () => {
	const { scripts } = await Bun.file(
		new URL('../../../package.json', import.meta.url),
	).json();
	expect(scripts['dev:api-dashboard']).toBe(
		'API_PUBLIC_ORIGIN=http://localhost:5178 bun run --filter @epicenter/api --filter @epicenter/api-ui dev',
	);
	expect(scripts['dev:api']).toBe('bun run --cwd apps/api dev');
	expect(scripts['dev:epicenter']).toBe(
		'EPICENTER_API_URL=http://localhost:8787 bun run --filter @epicenter/api --filter @epicenter/epicenter dev',
	);
});

test('dev launcher rejects unsafe origins before building or changing config', async () => {
	const fixture = await localLauncher();
	try {
		for (const origin of [
			'https://localhost:5178',
			'http://example.com:5178',
			'http://localhost:5178/',
		]) {
			const result = await fixture.run(origin);
			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain(
				'API_PUBLIC_ORIGIN must be an HTTP loopback origin for local dev.',
			);
			expect(await Bun.file(fixture.commands).exists()).toBe(false);
			expect(await Bun.file(fixture.generated).exists()).toBe(false);
			expect(await readFile(fixture.devVars, 'utf8')).toBe(
				'local-secret=untouched\n',
			);
		}
	} finally {
		await fixture.remove();
	}
});

test('dev launcher strips production routes and Artifacts before invoking Wrangler', async () => {
	const fixture = await localLauncher();
	try {
		const result = await fixture.run('http://localhost:5178');
		expect(result.code).toBe(0);
		expect(await readFile(fixture.commands, 'utf8')).toBe(
			'run\n--cwd\nui\nbuild\n',
		);
		const original = Bun.JSONC.parse(
			await readFile(join(fixture.api, 'wrangler.jsonc'), 'utf8'),
		) as Record<string, unknown>;
		const generated = JSON.parse(
			await readFile(fixture.captured, 'utf8'),
		) as Record<string, unknown>;
		expect((original.routes as unknown[]).length).toBeGreaterThan(0);
		expect((original.artifacts as unknown[]).length).toBeGreaterThan(0);
		expect(generated.routes).toEqual([]);
		expect(generated.artifacts).toEqual([]);
		expect(generated.vars).toEqual({});
		expect((generated.secrets as { required: string[] }).required).toEqual(
			(original.secrets as { required: string[] }).required.filter(
				(name) => name !== 'ARTIFACTS_ACCOUNT_ID',
			),
		);
		expect(generated.assets).toEqual(original.assets);
		expect(await readFile(fixture.argumentsFile, 'utf8')).toBe(
			`run\n--silent\n--env=dev\n--path=/api\n--\nbun\nx\nwrangler\ndev\n--config\n${fixture.generated}\n--var\nAPI_PUBLIC_ORIGIN:http://localhost:5178\n`,
		);
		expect(await Bun.file(fixture.generated).exists()).toBe(false);
		expect(await Bun.file(fixture.devVars).exists()).toBe(false);
	} finally {
		await fixture.remove();
	}
});

async function localLauncher() {
	const root = await mkdtemp(join(import.meta.dir, '..', '.dev-test-'));
	const api = join(root, 'api');
	const scripts = join(api, 'scripts');
	const bin = join(root, 'bin');
	const commands = join(root, 'commands.txt');
	const captured = join(root, 'captured.json');
	const argumentsFile = join(root, 'arguments.txt');
	const generated = join(api, 'wrangler.dev.generated.json');
	const devVars = join(api, '.dev.vars');
	await mkdir(scripts, { recursive: true });
	await mkdir(bin);
	await writeFile(
		join(scripts, 'dev.ts'),
		await readFile(new URL('./dev.ts', import.meta.url), 'utf8'),
	);
	await writeFile(
		join(api, 'wrangler.jsonc'),
		await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'),
	);
	await writeFile(devVars, 'local-secret=untouched\n');
	await writeFile(
		join(bin, 'bun'),
		'#!/bin/sh\nprintf "%s\\n" "$@" > "$DEV_COMMANDS"\n',
		{ mode: 0o755 },
	);
	await writeFile(
		join(bin, 'infisical'),
		'#!/bin/sh\nif [ "$1" = "--silent" ] && [ "$2" = "user" ] && [ "$3" = "get" ]; then printf "test-token\\n"; exit 0; fi\nprintf "%s\\n" "$@" > "$DEV_ARGUMENTS"\ncp wrangler.dev.generated.json "$DEV_CAPTURE"\n',
		{ mode: 0o755 },
	);
	return {
		api,
		commands,
		captured,
		argumentsFile,
		generated,
		devVars,
		remove: () => rm(root, { recursive: true, force: true }),
		async run(origin: string) {
			const child = Bun.spawn([process.execPath, join(scripts, 'dev.ts')], {
				cwd: api,
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH ?? ''}`,
					API_PUBLIC_ORIGIN: origin,
					DEV_COMMANDS: commands,
					DEV_CAPTURE: captured,
					DEV_ARGUMENTS: argumentsFile,
				},
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
			return { stdout, stderr, code };
		},
	};
}
