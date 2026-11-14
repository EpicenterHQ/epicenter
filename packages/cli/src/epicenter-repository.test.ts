import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync } from 'node:fs';
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	REPOSITORIES,
	recordRepositories,
	snapshotEpicenter,
} from './epicenter-repository.ts';
import { bareApp, fixture, gitIn } from './runner.test-support.ts';

setDefaultTimeout(60_000);

const made: string[] = [];
afterEach(async () => {
	await Promise.all(
		made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

async function setup() {
	const f = await fixture();
	made.push(f.root);
	return f;
}

/** A bare repository under `root`, standing in for a GitHub origin. */
async function origin(root: string, name: string) {
	const path = join(root, 'origins', `${name}.git`);
	await mkdir(path, { recursive: true });
	await gitIn(path, 'init', '-q', '--bare');
	return path;
}

test('an Epicenter backs up what is beside its apps, and init --from rebuilds it from the origins alone', async () => {
	const f = await setup();
	const mine = join(f.root, 'Mine');
	expect((await f.run('init', mine, '--json')).code).toBe(0);
	// An app: its code and its data, each a repository with an origin.
	const vocab = await f.app(
		'vocab',
		bareApp('vocab').replace(/^.*\n/, ''),
		mine,
	);
	await f.folder(join(vocab, 'data'), {
		'.gitignore': '*.local\n*.local.*\n',
		'words/ni-hao.md': '---\nmeaning: hello\n---\n',
		'google.local.md': 'a token that stays here\n',
	});
	await gitIn(vocab, 'remote', 'add', 'origin', await origin(f.root, 'vocab'));
	await gitIn(
		join(vocab, 'data'),
		'remote',
		'add',
		'origin',
		await origin(f.root, 'vocab-data'),
	);
	// Beside the apps: a folder that is not one, and a file that stays here.
	await f.folder(
		join(mine, 'Zhongwen'),
		{ 'entries/first.md': 'a note\n', 'settings.local.md': 'mine\n' },
		{ git: false },
	);
	const home = await origin(f.root, 'epicenter');
	await gitIn(mine, 'remote', 'add', 'origin', home);

	const synced = await f.runIn(mine, 'sync', '--json');
	expect(synced.code).toBe(0);
	expect(JSON.parse(synced.stdout).epicenter).toMatchObject({
		pushed: true,
		origin: { ahead: 0 },
	});
	expect(JSON.parse(await readFile(join(mine, REPOSITORIES), 'utf8'))).toEqual({
		'apps/vocab': join(f.root, 'origins', 'vocab.git'),
		'apps/vocab/data': join(f.root, 'origins', 'vocab-data.git'),
	});
	const tracked = (await gitIn(mine, 'ls-files')).split('\n');
	expect(tracked).toContain('Zhongwen/entries/first.md');
	expect(tracked).toContain(REPOSITORIES);
	expect(tracked.some((path) => path.startsWith('apps/'))).toBe(false);
	expect(tracked.some((path) => path.includes('.local'))).toBe(false);

	const again = join(f.root, 'Restored');
	const restored = await f.run('init', '--from', home, again, '--json');
	expect(restored.code).toBe(0);
	expect(JSON.parse(restored.stdout)).toMatchObject({
		cloned: ['apps/vocab', 'apps/vocab/data'],
		unbacked: [],
		failed: [],
	});
	for (const path of [
		'EPICENTER.md',
		'AGENTS.md',
		'Zhongwen/entries/first.md',
		'apps/vocab/epicenter.ts',
		'apps/vocab/data/words/ni-hao.md',
	])
		expect(await readFile(join(again, path), 'utf8')).toBe(
			await readFile(join(mine, path), 'utf8'),
		);
	expect(existsSync(join(again, 'apps/vocab/data/google.local.md'))).toBe(
		false,
	);
	expect(existsSync(join(again, 'Zhongwen/settings.local.md'))).toBe(false);
	// The restored Epicenter lists and runs its app.
	expect(
		JSON.parse((await f.runIn(again, '--json')).stdout).apps,
	).toMatchObject([{ name: 'vocab' }]);

	// It never overwrites: a folder with anything in it is refused.
	const over = await f.run('init', '--from', home, again, '--json');
	expect(over.code).toBe(2);
	expect(JSON.parse(over.stdout).error.message).toBe(
		`${again} is already an Epicenter`,
	);
	await mkdir(join(f.root, 'Busy'));
	await writeFile(join(f.root, 'Busy', 'keep.md'), 'mine\n');
	const busy = await f.run(
		'init',
		'--from',
		home,
		join(f.root, 'Busy'),
		'--json',
	);
	expect(busy.code).toBe(2);
	expect(JSON.parse(busy.stdout).error.message).toBe(
		`${join(f.root, 'Busy')} is not empty; restore into a new folder`,
	);
});

test('a repository with no origin is listed as null and reported, not cloned', async () => {
	const f = await setup();
	const mine = join(f.root, 'Mine');
	await f.run('init', mine);
	await f.app('notes', bareApp('notes').replace(/^.*\n/, ''), mine);
	const home = await origin(f.root, 'epicenter');
	await gitIn(mine, 'remote', 'add', 'origin', home);
	expect((await f.runIn(mine, 'sync')).code).toBe(0);
	const again = join(f.root, 'Restored');
	const restored = await f.run('init', '--from', home, again);
	expect(restored.code).toBe(0);
	expect(restored.stderr).toContain(
		'apps/notes had no origin, so it was not restored.',
	);
	expect(existsSync(join(again, 'apps/notes'))).toBe(false);
});

test('the list records an http origin without the credentials written into it', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'epicenter-own-')));
	made.push(root);
	const other = join(root, 'apps', 'other');
	await mkdir(other, { recursive: true });
	await gitIn(other, 'init', '-q');
	await gitIn(
		other,
		'remote',
		'add',
		'origin',
		'https://someone:secret-token@example.com/someone/other.git',
	);
	const ssh = join(root, 'apps', 'ssh');
	await mkdir(ssh);
	await gitIn(ssh, 'init', '-q');
	await gitIn(ssh, 'remote', 'add', 'origin', 'git@github.com:someone/ssh.git');
	expect(await recordRepositories(root)).toEqual({
		'apps/other': 'https://example.com/someone/other.git',
		'apps/ssh': 'git@github.com:someone/ssh.git',
	});
});

test('a backup is refused while the .gitignore takes apps/, or a repository sits outside apps/, each with its next step', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'epicenter-own-')));
	made.push(root);
	const label = root.split('/').pop();
	await gitIn(root, 'init', '-q');
	await writeFile(join(root, '.gitignore'), 'drafts/\n');
	expect(await snapshotEpicenter(root)).toEqual({
		failed: {
			message: `${label}/.gitignore does not list apps/, so a backup of the Epicenter could take the apps`,
			next: `printf 'apps/\n' >> ${join(root, '.gitignore')}`,
		},
	});
	await writeFile(join(root, '.gitignore'), 'drafts/\napps/\n');
	const loose = join(root, 'loose');
	await mkdir(loose);
	await gitIn(loose, 'init', '-q');
	expect(await snapshotEpicenter(root)).toEqual({
		failed: {
			message: `${label}: loose is a repository outside apps/, which the Epicenter's backup cannot hold`,
			next: `mv ${loose} ${join(root, 'apps')}/`,
		},
	});
	expect(existsSync(join(root, REPOSITORIES))).toBe(false);
});

test('a repository committed inside the Epicenter as one is refused, with the step that removes it', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'epicenter-own-')));
	made.push(root);
	await gitIn(root, 'init', '-q');
	await writeFile(join(root, '.gitignore'), 'apps/\n');
	const inner = join(root, 'apps', 'inner');
	await mkdir(inner, { recursive: true });
	await writeFile(join(inner, 'a.md'), 'a\n');
	await gitIn(inner, 'init', '-q');
	await gitIn(inner, 'add', '-A');
	await gitIn(inner, 'commit', '-q', '-m', 'inner');
	// What a forced `git add` at the top does despite the ignore line.
	await gitIn(root, 'add', '-f', 'apps/inner');
	expect(await snapshotEpicenter(root)).toEqual({
		failed: {
			message: `${root.split('/').pop()} holds apps/inner as a repository inside it, which a clone cannot restore`,
			next: `git -C ${root} rm --cached -- apps/inner`,
		},
	});
});
