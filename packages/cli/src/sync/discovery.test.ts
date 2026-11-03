import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const box = mkdtempSync(join(tmpdir(), 'epicenter-discovery-'));
const home = join(box, 'home');
const library = join(box, 'library');
const bin = resolve(import.meta.dir, '..', 'bin.ts');

afterAll(() => rmSync(box, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]) {
	const ran = Bun.spawnSync(['git', ...args], {
		cwd,
		env: {
			PATH: process.env.PATH ?? '/usr/bin:/bin',
			HOME: home,
			GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
			GIT_CONFIG_NOSYSTEM: '1',
			GIT_CEILING_DIRECTORIES: box,
		},
	});
	expect(ran.exitCode).toBe(0);
}

function repository(path: string, synced = true) {
	mkdirSync(path, { recursive: true });
	git(path, 'init', '-q');
	if (synced) git(path, 'config', '--local', 'epicenter.synced', 'true');
}

async function status(environment: string) {
	const child = Bun.spawn(['bun', bin, 'status', '--json'], {
		cwd: box,
		env: {
			PATH: process.env.PATH ?? '/usr/bin:/bin',
			HOME: home,
			GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
			GIT_CONFIG_NOSYSTEM: '1',
			GIT_CEILING_DIRECTORIES: box,
			EPICENTER_ENVIRONMENT: environment,
			EPICENTER_DATA_DIR: join(box, 'data'),
		},
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(code, stderr).toBe(0);
	return stdout
		.trim()
		.split('\n')
		.filter(Boolean)
		.map(
			(line) =>
				(JSON.parse(line) as { status: { folder: string } }).status.folder,
		);
}

test('scan finds app and owner folders, follows app links, and stays in its environment', async () => {
	mkdirSync(home, { recursive: true });
	mkdirSync(library);
	symlinkSync(library, join(home, 'Epicenter'));
	const whispering = join(library, 'whispering');
	const zhongwen = join(library, 'bradenwong.com', 'zhongwen');
	const linkedTarget = join(box, 'moved-app');
	const linked = join(library, 'linked');
	const ignored = join(library, 'ignored');
	const deepTarget = join(box, 'deep-target');
	repository(whispering);
	repository(zhongwen);
	repository(linkedTarget);
	symlinkSync(linkedTarget, linked);
	repository(ignored, false);
	repository(deepTarget);
	symlinkSync(deepTarget, join(whispering, 'deep-link'));
	symlinkSync(whispering, join(library, 'zz-alias'));
	const dev = join(home, 'Epicenter Dev', 'development');
	repository(dev);
	expect(await status('production')).toEqual([
		join(home, 'Epicenter', 'bradenwong.com', 'zhongwen'),
		join(home, 'Epicenter', 'linked'),
		join(home, 'Epicenter', 'whispering'),
	]);
	expect(await status('development')).toEqual([dev]);
});
