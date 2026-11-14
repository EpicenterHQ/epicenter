/**
 * New app tests cover both initial repositories, name validation, the backup
 * status shown until origins receive the app's branches, and `--from`, which
 * takes another app's code by copying it.
 *
 * Key behaviors of `--from`:
 * - a path names the app's folder itself, a repository's root or a folder
 *   inside one; a Git URL names a repository, and `#<folder>` a folder in it
 * - it copies what the source's commit tracks in that folder, and never what
 *   is only on disk there
 * - the copy is a repository with one commit that names the source and the
 *   commit copied, and with no remote
 * - a source with no epicenter.ts, or with tracked data/, is refused
 * - a failure leaves no app folder and no temporary folder
 */
import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import {
	chmod,
	mkdir,
	readdir,
	readFile,
	readlink,
	realpath,
	rm,
	stat,
	symlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { COMMANDS } from './commands.ts';
import { VERSION } from './engines.ts';
import {
	bareApp,
	fixture,
	gitIn,
	gitignore,
	header,
} from './runner.test-support.ts';

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

test('new refuses duplicate names without regard to case and reserved words', async () => {
	const f = await fixture();
	roots.push(f.root);
	await mkdir(join(f.apps, 'Reading'));
	for (const name of ['reading', 'serve', 'init', 'build', 'Bad_Name']) {
		const result = await f.run('new', name, '--json');
		expect(result.code).toBe(2);
		expect(JSON.parse(result.stdout).error.name).toBe('Usage');
	}
});

test('new commits its template and link is a valid app name', async () => {
	const f = await fixture();
	roots.push(f.root);
	const made = await f.run('new', 'garden');
	expect(made.code).toBe(0);
	const garden = join(f.apps, 'garden');
	expect(made.stderr).toBe(
		`Run: epicenter garden\nnot backed up\nRun: git -C ${garden} remote add origin <url> and git -C ${garden}/data remote add origin <url>, each a private repository, then epicenter sync garden\n`,
	);
	expect(await readFile(join(garden, '.gitignore'), 'utf8')).toBe(
		'data/\nnode_modules/\n',
	);
	expect(await readFile(join(garden, 'data', '.gitignore'), 'utf8')).toBe(
		'*.local\n*.local.*\n',
	);
	expect(await gitIn(garden, 'log', '--format=%s')).toBe('new garden');
	expect(await gitIn(join(garden, 'data'), 'log', '--format=%s')).toBe(
		'garden: start its data',
	);
	expect(await gitIn(join(garden, 'data'), 'ls-files')).toBe('.gitignore');
	expect(await gitIn(garden, 'ls-files')).toBe(
		'.gitignore\nepicenter.ts\npackage.json',
	);
	expect(
		JSON.parse(await readFile(join(garden, 'package.json'), 'utf8')).engines,
	).toEqual({ epicenter: `>=${VERSION}` });
	expect(await gitIn(garden, 'status', '--porcelain')).toBe('');
	expect(await realpath(join(garden, 'node_modules/@epicenter/app'))).toBe(
		await realpath(join(import.meta.dir, '../../app')),
	);

	expect((await f.run('new', 'link')).code).toBe(0);
	expect(await gitIn(join(f.apps, 'link'), 'log', '--format=%s')).toBe(
		'new link',
	);
});

test('listings distinguish no origin, an origin never pushed to, and a pushed backup', async () => {
	const f = await fixture();
	roots.push(f.root);
	expect((await f.run('new', 'garden')).code).toBe(0);
	const garden = join(f.apps, 'garden');
	expect((await f.run('garden')).stdout).toContain(
		`data: not backed up\nRun: git -C ${garden} remote add origin <url> and git -C ${garden}/data remote add origin <url>, then epicenter sync garden`,
	);
	expect(JSON.parse((await f.run('--json')).stdout).apps[0].status).toEqual({
		code: { pending: 0, backup: 'none' },
		data: { pending: 0, backup: 'none' },
	});
	expect((await f.run()).stdout).toContain(
		`(code: not backed up; data: not backed up)\n\nRun: epicenter <app>\nRun: git -C ${garden} remote add origin <url> and git -C ${garden}/data remote add origin <url>, then epicenter sync garden`,
	);

	const backup = join(f.root, 'backup.git');
	await gitIn(f.root, 'init', '-q', '--bare', backup);
	await gitIn(garden, 'remote', 'add', 'origin', backup);
	expect((await f.run('garden')).stdout).toContain('code: never backed up');
	expect(JSON.parse((await f.run('garden', '--json')).stdout).status).toEqual({
		code: { pending: 0, backup: 'never' },
		data: { pending: 0, backup: 'none' },
	});
	expect((await f.run()).stdout).toContain('code: never backed up');

	expect((await f.run('sync', 'garden')).code).toBe(0);
	expect(JSON.parse((await f.run('garden', '--json')).stdout)).toHaveProperty(
		'status.data.backup',
		'none',
	);
	expect((await f.run()).stdout).toContain('data: not backed up');
});

// ============================================================================
// new --from: taking another app's code
// ============================================================================

/**
 * A fixture with a repository at `<root>/source` whose one commit holds
 * `files`, and a temporary folder of its own at `tmp`, so a test can see
 * whether `new` left anything there.
 */
async function sourceFixture(files: Record<string, string>) {
	const f = await fixture();
	roots.push(f.root);
	const source = await f.folder(join(f.root, 'source'), files);
	const tmp = join(f.root, 'tmp');
	await mkdir(tmp);
	f.env.TMPDIR = tmp;
	return { ...f, source, tmp };
}

/** A source holding two apps, each in a folder of its own, and no app at its root. */
const twoApps = {
	'README.md': 'two apps\n',
	'.gitignore': 'dist/\n',
	'apps/vocab/epicenter.ts': bareApp('vocab'),
	'apps/vocab/ui/index.html': '<p>vocab</p>\n',
	'apps/tasks/epicenter.ts': bareApp('tasks'),
};

/** The `Source:` trailer of each commit in `app`, one line each. */
function sourceOf(app: string) {
	return gitIn(app, 'log', '--format=%(trailers:key=Source,valueonly)');
}

test('new --from a repository root makes one commit that names the source, with no remote', async () => {
	const f = await sourceFixture({
		'.gitignore': gitignore,
		'epicenter.ts': bareApp('vocab'),
		'ui/index.html': '<p>vocab</p>\n',
	});
	const commit = await gitIn(f.source, 'rev-parse', 'HEAD');
	const made = await f.run('new', 'vocab', '--from', f.source, '--json');
	expect(made.code).toBe(0);
	const app = join(f.apps, 'vocab');
	expect(JSON.parse(made.stdout)).toEqual({ name: 'vocab', folder: app });
	expect(await gitIn(app, 'log', '--format=%B')).toBe(
		`new vocab\n\nSource: ${f.source}\nSource-Commit: ${commit}`,
	);
	expect(await gitIn(app, 'remote')).toBe('');
	expect(await gitIn(app, 'ls-files')).toBe(
		'.gitignore\nepicenter.ts\nui/index.html',
	);
	expect(await readFile(join(app, '.gitignore'), 'utf8')).toBe(gitignore);
	expect(await gitIn(app, 'status', '--porcelain')).toBe('');
	expect(await gitIn(join(app, 'data'), 'log', '--format=%s')).toBe(
		'vocab: start its data',
	);
	expect(existsSync(join(app, 'ui', 'dist'))).toBe(false);
	expect(await readdir(f.apps)).toEqual(['vocab']);
	expect(await readdir(f.tmp)).toEqual([]);
});

test('new --from a folder inside a repository takes that folder alone, and only what its commit tracks', async () => {
	const f = await sourceFixture(twoApps);
	const from = join(f.source, 'apps/vocab');
	await f.folder(
		from,
		{
			'data/words/neko.md': 'cat\n',
			'node_modules/left-pad/index.js': '',
			'ui/dist/index.html': 'built\n',
			'notes.md': 'untracked\n',
		},
		{ git: false },
	);
	expect((await f.run('new', 'words', '--from', from)).code).toBe(0);
	const app = join(f.apps, 'words');
	expect(await gitIn(app, 'ls-files')).toBe(
		'.gitignore\nepicenter.ts\nui/index.html',
	);
	expect(await gitIn(app, 'log', '--format=%B')).toBe(
		`new words\n\nSource: ${from}\nSource-Commit: ${await gitIn(f.source, 'rev-parse', 'HEAD')}`,
	);
	expect(await gitIn(app, 'remote')).toBe('');
	for (const path of [
		'apps',
		'README.md',
		'data/words',
		'node_modules/left-pad',
		'ui/dist',
		'notes.md',
	])
		expect(existsSync(join(app, path))).toBe(false);
	// The folder relied on the .gitignore at its repository's root, which stays behind.
	expect(await readFile(join(app, '.gitignore'), 'utf8')).toBe(gitignore);
	expect(await gitIn(app, 'status', '--porcelain')).toBe('');
	expect(await readdir(f.tmp)).toEqual([]);
});

test('new --from <git url>#<folder> takes that folder alone from a repository holding two apps', async () => {
	const f = await sourceFixture(twoApps);
	const from = `file://${f.source}#apps/vocab`;
	expect((await f.run('new', 'words', '--from', from)).code).toBe(0);
	const app = join(f.apps, 'words');
	expect(await gitIn(app, 'ls-files')).toBe(
		'.gitignore\nepicenter.ts\nui/index.html',
	);
	expect(await gitIn(app, 'log', '--format=%B')).toBe(
		`new words\n\nSource: ${from}\nSource-Commit: ${await gitIn(f.source, 'rev-parse', 'HEAD')}`,
	);
	expect(await gitIn(app, 'remote')).toBe('');

	const spelled = `file://${f.source}#./apps/vocab/`;
	expect((await f.run('new', 'again', '--from', spelled)).code).toBe(0);
	expect(await gitIn(join(f.apps, 'again'), 'ls-files')).toBe(
		'.gitignore\nepicenter.ts\nui/index.html',
	);
	expect(await sourceOf(join(f.apps, 'again'))).toBe(spelled);
});

test('new --from records a relative path as the absolute folder it named', async () => {
	const f = await sourceFixture(twoApps);
	const made = await f.runIn(
		join(f.source, 'apps'),
		'new',
		'vocab',
		'--from',
		'./vocab',
	);
	expect(made.code).toBe(0);
	expect(await sourceOf(join(f.apps, 'vocab'))).toBe(
		join(f.source, 'apps', 'vocab'),
	);
});

test('new --from adds only the ignore lines a copied .gitignore lacks', async () => {
	const f = await sourceFixture({
		'apps/vocab/.gitignore': 'dist/\nnode_modules/',
		'apps/vocab/epicenter.ts': bareApp('vocab'),
	});
	const from = join(f.source, 'apps/vocab');
	expect((await f.run('new', 'vocab', '--from', from)).code).toBe(0);
	expect(await readFile(join(f.apps, 'vocab', '.gitignore'), 'utf8')).toBe(
		'dist/\nnode_modules/\ndata/\n',
	);
	expect(await gitIn(join(f.apps, 'vocab'), 'status', '--porcelain')).toBe('');
});

test('new --from copies what the commit tracks, an ignored file included, never data, packages, builds, or edits only on disk', async () => {
	const f = await sourceFixture({
		'.gitignore': 'data/\nnode_modules/\nui/dist/\n',
		'epicenter.ts': bareApp('vocab'),
		'README.md': 'committed\n',
		'ui/dist/kept.html': 'tracked though ignored\n',
	});
	await gitIn(f.source, 'add', '-f', 'ui/dist/kept.html');
	await gitIn(f.source, 'commit', '-q', '-m', 'keep one built file');
	await f.folder(
		f.source,
		{
			'data/words/neko.md': 'cat\n',
			'node_modules/left-pad/index.js': '',
			'ui/dist/index.html': 'built\n',
			'notes.md': 'untracked\n',
			'README.md': 'edited, not committed\n',
		},
		{ git: false },
	);
	expect((await f.run('new', 'vocab', '--from', f.source)).code).toBe(0);
	const app = join(f.apps, 'vocab');
	expect(await gitIn(app, 'ls-files')).toBe(
		'.gitignore\nREADME.md\nepicenter.ts\nui/dist/kept.html',
	);
	expect(await gitIn(app, 'status', '--porcelain')).toBe('');
	expect(await readFile(join(app, 'README.md'), 'utf8')).toBe('committed\n');
	for (const path of [
		'data/words',
		'node_modules/left-pad',
		'ui/dist/index.html',
		'notes.md',
	])
		expect(existsSync(join(app, path))).toBe(false);
	expect(await gitIn(join(app, 'data'), 'ls-files')).toBe('.gitignore');
});

test("new --from keeps an executable file's mode and a symlink", async () => {
	const f = await sourceFixture({
		'.gitignore': gitignore,
		'epicenter.ts': bareApp('vocab'),
		'scripts/build.sh': '#!/bin/sh\n',
	});
	await chmod(join(f.source, 'scripts/build.sh'), 0o755);
	await symlink('scripts/build.sh', join(f.source, 'build'));
	await gitIn(f.source, 'add', '-A');
	await gitIn(f.source, 'commit', '-q', '-m', 'an executable and a link');
	expect((await f.run('new', 'vocab', '--from', f.source)).code).toBe(0);
	const app = join(f.apps, 'vocab');
	expect((await stat(join(app, 'scripts/build.sh'))).mode & 0o777).toBe(0o755);
	expect(await readlink(join(app, 'build'))).toBe('scripts/build.sh');
	expect(await gitIn(app, 'ls-files', '-s', 'build', 'scripts')).toMatch(
		/^120000 .*\tbuild\n100755 .*\tscripts\/build\.sh$/,
	);
});

test('new --from refuses a folder that tracks no epicenter.ts, naming it, and makes nothing', async () => {
	const f = await sourceFixture(twoApps);
	const url = `file://${f.source}`;
	// An epicenter.ts on disk that no commit holds is not one to take.
	await f.folder(
		join(f.source, 'apps/reading'),
		{ 'epicenter.ts': bareApp('reading') },
		{ git: false },
	);
	for (const [from, message] of [
		[
			url,
			`${url} has no epicenter.ts that Git tracks; name the app's folder with --from ${url}#<folder>`,
		],
		[
			`${url}#apps/reading`,
			`${url}#apps/reading has no epicenter.ts that Git tracks`,
		],
		[f.source, `${f.source} has no epicenter.ts that Git tracks`],
		[
			join(f.source, 'apps/reading'),
			`${f.source}/apps/reading has no epicenter.ts that Git tracks`,
		],
	] as const) {
		const refused = await f.run('new', 'vocab', '--from', from, '--json');
		expect(refused.code).toBe(2);
		expect(JSON.parse(refused.stdout).error).toEqual({
			name: 'Usage',
			message,
		});
	}
	expect(await readdir(f.apps)).toEqual([]);
	expect(await readdir(f.tmp)).toEqual([]);
});

test('new --from refuses a source that tracks data/, since data is never copied', async () => {
	const f = await sourceFixture({
		'apps/vocab/epicenter.ts': bareApp('vocab'),
		'apps/vocab/data/words/neko.md': 'cat\n',
	});
	const from = join(f.source, 'apps/vocab');
	const refused = await f.run('new', 'vocab', '--from', from, '--json');
	expect(refused.code).toBe(2);
	expect(JSON.parse(refused.stdout).error).toEqual({
		name: 'Usage',
		message: `${from} tracks files under data/, and an app's data is never copied`,
	});
	expect(await readdir(f.apps)).toEqual([]);
	expect(await readdir(f.tmp)).toEqual([]);
});

test('new --from refuses a path outside any Git repository', async () => {
	const f = await sourceFixture(twoApps);
	for (const from of [f.tmp, join(f.root, 'nowhere')]) {
		const refused = await f.run('new', 'vocab', '--from', from, '--json');
		expect(refused.code).toBe(2);
		expect(JSON.parse(refused.stdout).error).toEqual({
			name: 'Usage',
			message: `${from} is not in a Git repository; --from takes only the files Git tracks`,
		});
	}
	expect(await readdir(f.apps)).toEqual([]);
});

test('new --from reads # in a Git URL alone: its first # starts the folder, and a path keeps its own', async () => {
	const f = await sourceFixture({
		'apps/c#/epicenter.ts': bareApp('csharp'),
	});
	const url = `file://${f.source}`;
	expect(
		(await f.run('new', 'from-url', '--from', `${url}#apps/c#`)).code,
	).toBe(0);
	expect(await sourceOf(join(f.apps, 'from-url'))).toBe(`${url}#apps/c#`);
	const path = join(f.source, 'apps/c#');
	expect((await f.run('new', 'from-path', '--from', path)).code).toBe(0);
	expect(await sourceOf(join(f.apps, 'from-path'))).toBe(path);

	const outside =
		"is not a folder inside the repository; write its path from the repository's root, without ..";
	for (const [from, why] of [
		[`${url}#`, `--from ${url}# names no folder after #`],
		[`${url}#/apps/c#`, `"/apps/c#" ${outside}`],
		[`${url}#apps/../..`, `"apps/../.." ${outside}`],
	] as const) {
		const result = await f.run('new', 'other', '--from', from, '--json');
		expect(result.code).toBe(2);
		expect(JSON.parse(result.stdout).error).toEqual({
			name: 'Usage',
			message: `${why}\nUsage: ${COMMANDS.new.usage}`,
			next: 'epicenter new --help',
		});
	}
	expect((await readdir(f.apps)).sort()).toEqual(['from-path', 'from-url']);
	expect(await readdir(f.tmp)).toEqual([]);
});

test('new --from refuses an app whose epicenter.ts does not load, and leaves no folder', async () => {
	const f = await sourceFixture({
		'.gitignore': gitignore,
		'epicenter.ts': `${header}defineCollection({ path: 'data/words/', fields: {} });\n`,
	});
	const made = await f.run('new', 'vocab', '--from', f.source, '--json');
	expect(made.code).toBe(2);
	expect(JSON.parse(made.stdout).error).toMatchObject({
		name: 'AppProblems',
		problems: [
			'epicenter.ts: The collection path data/words/ is not a .md path',
		],
	});
	expect(await readdir(f.apps)).toEqual([]);
	expect(await readdir(f.tmp)).toEqual([]);
});

test('new --from a Git URL that cannot be cloned leaves nothing behind', async () => {
	const f = await sourceFixture(twoApps);
	const failed = await f.run(
		'new',
		'other',
		'--from',
		`file://${f.root}/nowhere`,
		'--json',
	);
	expect(failed.code).toBe(2);
	expect(JSON.parse(failed.stdout).error.name).toBe('GitFailed');
	expect(await readdir(f.apps)).toEqual([]);
	expect(await readdir(f.tmp)).toEqual([]);
});
