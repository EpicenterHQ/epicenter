/** Serve keeps no checkpoint clock; a home checkpoints through a routine (ADR-0937). */
import { afterAll, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkpoint } from './checkpoint.ts';
import { startHttpServer } from './http.ts';
import { fixture, gitIn } from './runner.test-support.ts';

const f = await fixture();
process.env.EPICENTER_ROOT = f.home;
process.env.EPICENTER_RUNTIME_DIR = join(f.root, 'run-runtime');
afterAll(() => rm(f.root, { recursive: true, force: true }));

test('serve commits nothing on its own, and a checkpoint routine commits at its first check', async () => {
	await gitIn(f.home, 'init', '-q');
	// As `init` writes it: routine state and logs stay local.
	await writeFile(join(f.home, '.gitignore'), '*.local\n*.local.*\n');
	await checkpoint(f.home);
	const before = await gitIn(f.home, 'rev-parse', 'HEAD');
	await writeFile(join(f.home, 'direct'), 'start');
	let server = startHttpServer(0);
	await Bun.sleep(300);
	await server.stop();
	expect(await gitIn(f.home, 'rev-parse', 'HEAD')).toBe(before);

	await mkdir(join(f.home, 'routines'));
	await writeFile(
		join(f.home, 'routines/checkpoint.md'),
		'---\ncron: "*/5 * * * *"\nrun: ["epicenter", "checkpoint"]\n---\n',
	);
	server = startHttpServer(0);
	try {
		const deadline = Date.now() + 15_000;
		while (
			(await gitIn(f.home, 'show', 'HEAD:direct').catch(() => '')) !== 'start'
		) {
			if (Date.now() > deadline)
				throw new Error(
					`The checkpoint routine did not commit:\n${await Bun.file(
						join(f.home, 'routines/checkpoint.local/output.log'),
					)
						.text()
						.catch(() => 'no log')}`,
				);
			await Bun.sleep(50);
		}
	} finally {
		await server.stop();
	}
}, 30_000);
