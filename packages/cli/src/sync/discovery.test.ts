/** Discovery tests: scan depth, realpath dedupe, and unavailable candidates. */
import { afterAll, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
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
				(JSON.parse(line) as { status: { folder: string; problem?: string } })
					.status,
		);
}

async function cli(...args: string[]) {
	const child = Bun.spawn(['bun', bin, ...args], {
		cwd: box,
		env: {
			PATH: process.env.PATH ?? '/usr/bin:/bin',
			HOME: home,
			GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
			GIT_CONFIG_NOSYSTEM: '1',
			GIT_CEILING_DIRECTORIES: box,
			EPICENTER_ENVIRONMENT: 'production',
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
	return { stdout, stderr, code };
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
	expect((await status('production')).map((entry) => entry.folder)).toEqual([
		join(home, 'Epicenter', 'bradenwong.com', 'zhongwen'),
		join(home, 'Epicenter', 'ignored'),
		join(home, 'Epicenter', 'linked'),
		join(home, 'Epicenter', 'whispering'),
	]);
	expect(
		(await status('production')).find((entry) =>
			entry.folder.endsWith('ignored'),
		)?.problem,
	).toBe('its repository is not set up for sync');
	expect((await status('development')).map((entry) => entry.folder)).toEqual([
		dev,
	]);
});

test('dead links and unadopted repositories remain rows while plain owner directories stay out', async () => {
	const dead = join(library, 'dead');
	symlinkSync(join(box, 'missing'), dead);
	const unadopted = join(library, 'unadopted');
	repository(unadopted, false);
	mkdirSync(join(library, 'plain', 'empty'), { recursive: true });
	const broken = join(library, 'broken-git');
	mkdirSync(broken);
	writeFileSync(join(broken, '.git'), 'bad gitdir');
	const plainTarget = join(box, 'plain-link-target');
	mkdirSync(plainTarget);
	symlinkSync(plainTarget, join(library, 'plain-link-a'));
	symlinkSync(plainTarget, join(library, 'plain-link-b'));
	const rows = await status('production');
	expect(
		rows.find((row) => row.folder === join(home, 'Epicenter', 'dead'))?.problem,
	).toBe('not on disk');
	expect(
		rows.find((row) => row.folder === join(home, 'Epicenter', 'unadopted'))
			?.problem,
	).toBe('its repository is not set up for sync');
	expect(
		rows.find((row) => row.folder === join(home, 'Epicenter', 'broken-git'))
			?.problem,
	).toBe('not in a Git repository');
	expect(rows.some((row) => row.folder.includes('/plain/'))).toBe(false);
	expect(rows.filter((row) => row.folder.includes('plain-link-')).length).toBe(
		1,
	);
});

test('init links an outside folder and refuses a taken library name before consent', async () => {
	const external = join(box, 'external', 'new-notes');
	const missing = await cli('init', external, '--json');
	expect(missing.code).toBe(2);
	expect(JSON.parse(missing.stdout).error).toContain(
		'--name "new-notes folder"',
	);
	expect(existsSync(external)).toBe(false);
	for (const name of ['notes', 'BRADENWONG.COM']) {
		const claimable = await cli('init', external, '--name', name, '--json');
		expect(claimable.code).toBe(2);
		expect(JSON.parse(claimable.stdout).error).toContain(
			'could name an app or owner',
		);
	}
	const enrolled = await cli(
		'init',
		external,
		'--name',
		'Obsidian Vault',
		'--json',
	);
	expect(enrolled.code, enrolled.stderr).toBe(0);
	expect(readlinkSync(join(library, 'Obsidian Vault'))).toBe(
		realpathSync(external),
	);
	expect(
		(await status('production')).some(
			(row) =>
				row.folder === join(home, 'Epicenter', 'Obsidian Vault') &&
				row.problem === undefined,
		),
	).toBe(true);
	expect((await cli('sync', external, '--json')).code).toBe(0);

	const taken = join(library, 'Taken folder');
	mkdirSync(taken);
	const outside = join(box, 'external', 'taken');
	const refused = await cli(
		'init',
		outside,
		'--name',
		'taken FOLDER',
		'--json',
	);
	expect(refused.code).toBe(2);
	const refusal = JSON.parse(refused.stdout).error;
	expect(refusal).toContain(outside);
	expect(refusal).toContain(taken);
	expect(refusal).toContain('--name "taken folder 2"');
	expect(existsSync(outside)).toBe(false);
});

test('init keeps an owner-level link when it already reaches the folder', async () => {
	const target = join(box, 'owner-target');
	repository(target, false);
	git(target, 'symbolic-ref', 'HEAD', 'refs/heads/main');
	const owner = join(library, 'another-owner');
	mkdirSync(owner);
	symlinkSync(target, join(owner, 'notes'));
	const enrolled = await cli(
		'init',
		target,
		'--name',
		'Owner notes folder',
		'--json',
	);
	expect(enrolled.code, enrolled.stderr).toBe(0);
	expect(
		(await status('production')).some(
			(row) =>
				row.folder === join(home, 'Epicenter', 'another-owner', 'notes') &&
				row.problem === undefined,
		),
	).toBe(true);
	expect(existsSync(join(library, 'owner-target'))).toBe(false);
});

test('init links a repository that sits deeper than the scan', async () => {
	const deep = join(library, 'plain', 'deeper', 'deep-app');
	const enrolled = await cli(
		'init',
		deep,
		'--name',
		'deep-app folder',
		'--json',
	);
	expect(enrolled.code, enrolled.stderr).toBe(0);
	expect(readlinkSync(join(library, 'deep-app folder'))).toBe(
		realpathSync(deep),
	);
	expect(
		(await status('production')).some(
			(row) =>
				row.folder === join(home, 'Epicenter', 'deep-app folder') &&
				row.problem === undefined,
		),
	).toBe(true);
});

test('a dead link does not end sync watch', async () => {
	const child = Bun.spawn(
		['bun', bin, 'sync', '--watch', '--interval', '1', '--json'],
		{
			cwd: box,
			env: {
				PATH: process.env.PATH ?? '/usr/bin:/bin',
				HOME: home,
				GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
				GIT_CONFIG_NOSYSTEM: '1',
				GIT_CEILING_DIRECTORIES: box,
				EPICENTER_ENVIRONMENT: 'production',
				EPICENTER_DATA_DIR: join(box, 'data'),
			},
			stdout: 'ignore',
			stderr: 'ignore',
		},
	);
	try {
		await Bun.sleep(2500);
		expect(child.exitCode).toBeNull();
	} finally {
		child.kill('SIGKILL');
		await child.exited;
	}
}, 10_000);
