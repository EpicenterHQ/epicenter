/**
 * The compiled `epicenter` binary is the CLI (ADR-0556) and runs without a
 * system Bun on `PATH`.
 */

import { expect, test } from 'bun:test';
import { join } from 'node:path';

const appDir = join(import.meta.dir, '..');

async function hostTargetTriple(): Promise<string> {
	const process = Bun.spawn(['rustc', '-vV'], { stdout: 'pipe' });
	const output = await new Response(process.stdout).text();
	expect(await process.exited).toBe(0);
	const host = output
		.split('\n')
		.find((line) => line.startsWith('host: '))
		?.slice('host: '.length)
		.trim();
	if (!host) throw new Error('rustc did not report a host triple');
	return host;
}

async function run(
	command: string[],
	env: Record<string, string>,
): Promise<{ code: number; stdout: string }> {
	const process = Bun.spawn(command, { env, stdout: 'pipe', stderr: 'pipe' });
	const [code, stdout] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
	]);
	return { code, stdout };
}

test('the compiled binary is the CLI, without a system Bun', async () => {
	const build = Bun.spawn(['bun', 'run', 'build:sidecar'], {
		cwd: appDir,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	if ((await build.exited) !== 0) {
		throw new Error(await new Response(build.stderr).text());
	}
	const binary = join(
		appDir,
		'src-tauri',
		'binaries',
		`epicenter-cli-${await hostTargetTriple()}`,
	);

	const cli = await run([binary, '--version'], { PATH: '' });
	expect(cli.code).toBe(0);
	expect(cli.stdout).toStartWith('epicenter ');
}, 120_000);
