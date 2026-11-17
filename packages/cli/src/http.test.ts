/** Serve owns the root checkpoint clock: startup, explicit ticks, shutdown, and deduplicated failure logging. */
import { afterAll, expect, test } from 'bun:test';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkpoint } from './checkpoint.ts';
import { startHttpServer } from './http.ts';
import { fixture, gitIn } from './runner.test-support.ts';

const f = await fixture();
process.env.EPICENTER_ROOT = f.home;
process.env.EPICENTER_RUNTIME_DIR = join(f.root, 'run-runtime');
afterAll(() => rm(f.root, { recursive: true, force: true }));

test('serve checkpoints at startup and shutdown and tick resolves the root result', async () => {
	await gitIn(f.home, 'init', '-q');
	await checkpoint(f.home);
	await writeFile(join(f.home, 'direct'), 'start');
	const server = startHttpServer(0);
	try {
		const idle = await server.tick();
		expect(idle.committed).toBeNull();
		expect(await gitIn(f.home, 'show', 'HEAD:direct')).toBe('start');
		expect(await gitIn(f.home, 'log', '-1', '--format=%s')).toBe(
			'checkpoint: root files',
		);
		await writeFile(join(f.home, 'direct'), 'stop');
	} finally {
		await server.stop();
	}
	expect(await gitIn(f.home, 'show', 'HEAD:direct')).toBe('stop');
});

test('serve logs each changed checkpoint failure once and clears it after success', async () => {
	const server = startHttpServer(0);
	await server.tick();
	const write = process.stderr.write;
	let output = '';
	process.stderr.write = ((chunk: string | Uint8Array) => {
		output += String(chunk);
		return true;
	}) as typeof process.stderr.write;
	try {
		await writeFile(join(f.home, 'token.local'), 'secret');
		await server.tick();
		await server.tick();
		expect(output.match(/token.local would be committed/g)).toHaveLength(1);
		await rm(join(f.home, 'token.local'));
		await server.tick();
		await writeFile(join(f.home, 'token.local'), 'secret');
		await server.tick();
		expect(output.match(/token.local would be committed/g)).toHaveLength(2);
	} finally {
		await rm(join(f.home, 'token.local'), { force: true });
		process.stderr.write = write;
		await server.stop();
	}
});
