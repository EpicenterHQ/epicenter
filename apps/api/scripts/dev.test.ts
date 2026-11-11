/**
 * Dashboard startup selects localhost:5178. The development launcher accepts
 * only loopback origins and constructs a route-free local Wrangler command.
 * Disposable copies and fake tool executables keep the launcher effects local.
 */
import { expect, test } from 'bun:test';
import {
	cp,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiRoot = fileURLToPath(new URL('..', import.meta.url));

async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-api-dev-test-'));
	const bin = join(root, 'bin');
	await mkdir(join(root, 'scripts'), { recursive: true });
	await mkdir(join(root, 'ui'), { recursive: true });
	await mkdir(bin);
	await cp(join(apiRoot, 'scripts/dev.ts'), join(root, 'scripts/dev.ts'));
	await cp(join(apiRoot, 'wrangler.jsonc'), join(root, 'wrangler.jsonc'));
	await symlink(join(apiRoot, 'node_modules'), join(root, 'node_modules'));
	await writeFile(join(root, '.dev.vars'), 'stale secret');

	await writeFile(
		join(bin, 'bun'),
		[
			`#!${process.execPath}`,
			'await Bun.write(process.env.API_DEV_TEST_BUN, JSON.stringify(process.argv.slice(2)));',
		].join('\n'),
		{ mode: 0o755 },
	);
	await writeFile(
		join(bin, 'infisical'),
		[
			`#!${process.execPath}`,
			'const args = process.argv.slice(2);',
			"if (args[0] === '--silent') {",
			'  await Bun.write(process.env.API_DEV_TEST_AUTH, JSON.stringify(args));',
			"  process.stdout.write('fictional-token\\n');",
			'} else {',
			"  const configPath = args[args.indexOf('--config') + 1];",
			'  const config = JSON.parse(await Bun.file(configPath).text());',
			'  await Bun.write(process.env.API_DEV_TEST_RUN, JSON.stringify({ args, config }));',
			'}',
		].join('\n'),
		{ mode: 0o755 },
	);

	async function run(origin: string | undefined) {
		const env: Record<string, string | undefined> = {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			API_DEV_TEST_BUN: join(root, 'bun.json'),
			API_DEV_TEST_AUTH: join(root, 'auth.json'),
			API_DEV_TEST_RUN: join(root, 'run.json'),
		};
		if (origin === undefined) delete env.API_PUBLIC_ORIGIN;
		else env.API_PUBLIC_ORIGIN = origin;
		const child = Bun.spawn([process.execPath, join(root, 'scripts/dev.ts')], {
			cwd: root,
			env,
			stdout: 'ignore',
			stderr: 'pipe',
		});
		const [stderr, exitCode] = await Promise.all([
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { stderr, exitCode };
	}

	return {
		root,
		run,
		cleanup: () => rm(root, { recursive: true, force: true }),
	};
}

test('dashboard startup supplies its public origin without changing ordinary API startup', async () => {
	const { scripts } = await Bun.file(
		new URL('../../../package.json', import.meta.url),
	).json();
	expect(scripts['dev:api-dashboard']).toBe(
		'API_PUBLIC_ORIGIN=http://localhost:5178 bun run --filter @epicenter/api --filter @epicenter/api-ui dev',
	);
	expect(scripts['dev:api']).toBe('bun run --cwd apps/api dev');
});

test('unsafe public origins are rejected before local cleanup or tool launch', async () => {
	const { root, run, cleanup } = await setup();
	try {
		for (const origin of [
			'https://api.epicenter.so',
			'http://0.0.0.0:8787',
			'http://localhost:8787/path',
		]) {
			const result = await run(origin);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain(
				'API_PUBLIC_ORIGIN must be an HTTP loopback origin for local dev.',
			);
			expect(await readFile(join(root, '.dev.vars'), 'utf8')).toBe(
				'stale secret',
			);
			expect(
				await readFile(join(root, 'bun.json'), 'utf8').catch(() => null),
			).toBeNull();
			expect(
				await readFile(join(root, 'auth.json'), 'utf8').catch(() => null),
			).toBeNull();
			expect(
				await readFile(join(root, 'run.json'), 'utf8').catch(() => null),
			).toBeNull();
		}
	} finally {
		await cleanup();
	}
});

test('valid public origins produce a route-free Wrangler invocation', async () => {
	const committed = Bun.JSONC.parse(
		await readFile(join(apiRoot, 'wrangler.jsonc'), 'utf8'),
	) as Record<string, unknown>;
	expect((committed.routes as unknown[]).length).toBeGreaterThan(0);
	for (const [override, expected] of [
		[undefined, 'http://localhost:8787'],
		['http://localhost:5178', 'http://localhost:5178'],
	] as const) {
		const { root, run, cleanup } = await setup();
		try {
			const result = await run(override);
			expect(result.exitCode).toBe(0);
			expect(
				JSON.parse(await readFile(join(root, 'bun.json'), 'utf8')),
			).toEqual(['run', '--cwd', 'ui', 'build']);
			expect(
				JSON.parse(await readFile(join(root, 'auth.json'), 'utf8')),
			).toEqual(['--silent', 'user', 'get', 'token', '--plain']);
			const launched = JSON.parse(
				await readFile(join(root, 'run.json'), 'utf8'),
			) as { args: string[]; config: Record<string, unknown> };
			expect(launched.args).toEqual([
				'run',
				'--silent',
				'--env=dev',
				'--path=/api',
				'--',
				'bun',
				'x',
				'wrangler',
				'dev',
				'--config',
				join(await realpath(root), 'wrangler.dev.generated.json'),
				'--var',
				`API_PUBLIC_ORIGIN:${expected}`,
			]);
			expect(launched.config).toEqual({ ...committed, routes: [] });
			expect(
				await readFile(join(root, '.dev.vars'), 'utf8').catch(() => null),
			).toBeNull();
			expect(
				await readFile(join(root, 'wrangler.dev.generated.json'), 'utf8').catch(
					() => null,
				),
			).toBeNull();
		} finally {
			await cleanup();
		}
	}
});
