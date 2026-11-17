/**
 * Run the shell installer against HTTP downloads in an isolated home. Verify repeat
 * installation, checksum rejection, and preservation of unrelated files and app data.
 */
import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('verified downloads install repeatedly without touching the Epicenter or shell configuration', async () => {
	const home = await mkdtemp(join(tmpdir(), 'epicenter-installer-'));
	const bytes = '#!/bin/sh\nprintf "%s\\n" "epicenter test-release"\n';
	let checksum = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
	const server = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		fetch(request) {
			return new Response(
				new URL(request.url).pathname.endsWith('.sha256') ? checksum : bytes,
			);
		},
	});
	const destination = join(home, '.local/bin/epicenter');
	const run = async () => {
		const child = Bun.spawn(['sh', join(import.meta.dir, '../install.sh')], {
			env: {
				...process.env,
				HOME: home,
				EPICENTER_INSTALL_DIR: join(home, '.local/bin'),
				EPICENTER_DOWNLOAD_BASE: server.url.href,
			},
			stdout: 'pipe',
			stderr: 'pipe',
		});
		return {
			code: await child.exited,
			stdout: await new Response(child.stdout).text(),
			stderr: await new Response(child.stderr).text(),
		};
	};
	try {
		await writeFile(join(home, '.zshrc'), '# my shell\n');
		expect((await run()).code).toBe(0);
		expect(await readFile(destination, 'utf8')).toBe(bytes);
		expect(existsSync(join(home, 'Epicenter'))).toBe(false);
		await mkdir(join(home, 'Epicenter'));
		await writeFile(join(home, 'Epicenter/keep.md'), 'My writing');
		expect((await run()).code).toBe(0);
		expect(await readFile(join(home, 'Epicenter/keep.md'), 'utf8')).toBe(
			'My writing',
		);
		expect(await readFile(join(home, '.zshrc'), 'utf8')).toBe('# my shell\n');
		checksum = '0'.repeat(64);
		const tampered = await run();
		expect(tampered.code).toBe(1);
		expect(tampered.stderr).toContain('Checksum mismatch');
		expect(await readFile(destination, 'utf8')).toBe(bytes);
		await writeFile(destination, '#!/bin/sh\necho unrelated\n', {
			mode: 0o755,
		});
		expect((await run()).stderr).toContain('nothing was replaced');
		expect(await readFile(destination, 'utf8')).toContain('unrelated');
	} finally {
		server.stop(true);
		await rm(home, { recursive: true, force: true });
	}
});
