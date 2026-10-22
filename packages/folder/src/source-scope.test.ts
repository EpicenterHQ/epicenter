/**
 * History Source Scope Tests
 *
 * Status, whole-folder commits, and incoming fast-forwards share one inclusion
 * rule: tracked files stay source, untracked files are source unless
 * `.gitignore` excludes them. SQLite filenames have no special source policy.
 *
 * Key behaviors:
 * - Root and nested `.gitignore` rules, negation, and ignored directories
 * - A tracked file stays tracked after a rule starts matching it
 * - A directory's history agrees with `git status` about what is dirty
 * - A fast-forward preserves ignored files and refuses to overwrite one
 *
 * See also:
 * - `index-reconcile.test.ts` for staged-only intent after a checkpoint
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	type DirectoryHistory,
	openDirectoryHistory,
} from './directory-history.test-support.js';
import { gitignoreMatcher } from './git/scope.js';
import {
	GIT_ENV,
	git,
	initWithOrigin,
	scratch,
} from './git-http.test-support.js';
import { put } from './put.test-support.js';

const author = { name: 'App', email: 'app@example.test' };
const originalGlobal = process.env.GIT_CONFIG_GLOBAL;

beforeAll(() => {
	process.env.GIT_CONFIG_GLOBAL = GIT_ENV.GIT_CONFIG_GLOBAL;
});
afterAll(() => {
	if (originalGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
	else process.env.GIT_CONFIG_GLOBAL = originalGlobal;
});

const encode = (text: string) => new TextEncoder().encode(text);

/** Files every scope test writes, relative to the folder root. */
const LAYOUT: Record<string, string> = {
	'.gitignore': '*.log\nbuild/\n',
	'notes/.gitignore': 'secret.txt\n!keep.log\n',
	'app.log': 'ignored at the root\n',
	'build/out.txt': 'inside an ignored directory\n',
	'notes/keep.log': 're-included by the nested file\n',
	'notes/secret.txt': 'ignored by the nested file\n',
	'notes/plain.txt': 'ordinary source\n',
	'index.sqlite3': 'an intentionally saved dataset\n',
};
const SOURCE = [
	'.gitignore',
	'index.sqlite3',
	'notes/.gitignore',
	'notes/keep.log',
	'notes/plain.txt',
].sort();

async function writeLayout(folder: DirectoryHistory) {
	for (const [path, text] of Object.entries(LAYOUT))
		expect((await put(folder, path, text)).error).toBeNull();
}

describe('gitignoreMatcher', () => {
	test('applies nested files, negation, and ignored directories', () => {
		const ignored = gitignoreMatcher(
			new Map(
				Object.entries(LAYOUT).map(([path, text]) => [path, encode(text)]),
			),
		);
		expect(
			Object.keys(LAYOUT)
				.filter((path) => !ignored(path))
				.sort(),
		).toEqual(SOURCE);
	});
});

describe('directory scope', () => {
	test('agrees with git status and never commits ignored files; tracked files stay tracked', async () => {
		const root = await scratch('scope-native-');
		await git(root, 'init', '--quiet', '--initial-branch=main');
		const folder = await openDirectoryHistory({ root, git: { author } });
		// Committed before any rule matches it.
		await folder.write('tracked.log', 'v1\n');
		expect((await folder.git.commit()).status).toBe('committed');
		await writeLayout(folder);
		const { data: status, error: statusError } = await folder.git.status();
		expect(statusError).toBeNull();
		expect(status?.changes.map((change) => change.path)).toEqual(SOURCE);
		await put(folder, 'tracked.log', 'v2\n');

		expect(
			(await folder.git.status()).data?.changes.map((change) => change.path),
		).toEqual([...SOURCE, 'tracked.log'].sort());
		const porcelain = (
			await git(root, 'status', '--porcelain', '--untracked-files=all')
		)
			.split('\n')
			.map((line) => line.replace(/^\S+\s+/, ''))
			.sort();
		expect(porcelain).toEqual([...SOURCE, 'tracked.log'].sort());

		expect((await folder.git.commit()).status).toBe('committed');
		expect((await git(root, 'ls-files')).split('\n').sort()).toEqual(
			[...SOURCE, 'tracked.log'].sort(),
		);
		expect(await git(root, 'status', '--porcelain')).toBe('');
		await folder.close();
	});

	test('a fast-forward preserves ignored files and refuses to overwrite one', async () => {
		const root = await scratch('scope-pull-');
		const bare = join(root, 'remote.git');
		await git(root, 'init', '--quiet', '--bare', '--initial-branch=main', bare);
		const writerRoot = join(root, 'writer');
		const readerRoot = join(root, 'reader');
		for (const path of [writerRoot, readerRoot])
			await initWithOrigin(path, bare);
		const writer = await openDirectoryHistory({
			root: writerRoot,
			git: { author },
		});
		const reader = await openDirectoryHistory({
			root: readerRoot,
			git: { author },
		});

		await writer.write('.gitignore', '*.log\n');
		expect((await writer.sync.run()).data?.kind).toBe('synced');
		expect((await reader.sync.run()).data?.kind).toBe('synced');

		// Ignored local files do not make the reader dirty and survive updates.
		await writeFile(join(readerRoot, 'local.log'), 'reader only\n');
		await writeFile(join(readerRoot, 'shared.log'), 'reader copy\n');
		await writer.write('readme.md', 'hello\n');
		expect((await writer.sync.run()).data?.kind).toBe('synced');
		expect((await reader.sync.run()).data?.kind).toBe('synced');
		expect(await readFile(join(readerRoot, 'local.log'), 'utf8')).toBe(
			'reader only\n',
		);

		// The writer force-tracks a path the reader has as an ignored file.
		await writeFile(join(writerRoot, 'shared.log'), 'writer copy\n');
		await git(writerRoot, 'add', '--force', 'shared.log');
		await git(writerRoot, 'commit', '--quiet', '-m', 'Track shared.log');
		expect((await writer.sync.run()).data?.kind).toBe('synced');
		const { error: collision } = await reader.sync.run();
		expect(collision?.name).toBe('Blocked');
		expect(collision?.message).toContain("'shared.log'");
		expect(await readFile(join(readerRoot, 'shared.log'), 'utf8')).toBe(
			'reader copy\n',
		);
		expect(await git(readerRoot, 'log', '-1', '--format=%s')).toBe(
			'Add readme.md',
		);
		await writer.close();
		await reader.close();
	});
});

test('native source uses captured ignore bytes and preserves machine-specific exclusions', async () => {
	const root = await scratch('scope-captured-');
	await git(root, 'init', '--quiet', '--initial-branch=main');
	await writeFile(join(root, '.git/info/exclude'), 'info-secret.txt\n');
	await writeFile(join(root, '.git/global-ignore'), 'global-secret.txt\n');
	await git(
		root,
		'config',
		'core.excludesFile',
		join(root, '.git/global-ignore'),
	);
	let ignoreChecks = 0;
	const folder = await openDirectoryHistory({
		root,
		git: { author },
		async beforeGit(args) {
			if (args.includes('check-ignore') && ++ignoreChecks === 2) {
				await writeFile(join(root, '.gitignore'), '');
			}
		},
	});
	try {
		for (const [path, text] of Object.entries({
			'.gitignore': '*.log\n',
			'take.log': 'Ignored by captured rule',
			'info-secret.txt': 'Ignored by Git info',
			'global-secret.txt': 'Ignored by machine config',
			'note.md': 'Shared',
		}))
			expect((await folder.write(path, text)).error).toBeNull();
		expect((await folder.git.commit()).status).toBe('committed');
		expect((await git(root, 'ls-files')).split('\n')).toEqual([
			'.gitignore',
			'note.md',
		]);
		expect(await git(root, 'show', 'HEAD:.gitignore')).toBe('*.log');
		expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('');
	} finally {
		await folder.close();
	}
});

test('a relative core.excludesFile keeps its meaning during captured-rule evaluation', async () => {
	const root = await scratch('scope-relative-excludes-');
	await git(root, 'init', '--quiet', '--initial-branch=main');
	await writeFile(join(root, '.git/machine-ignore'), '/audio/\n');
	await git(root, 'config', 'core.excludesFile', '.git/machine-ignore');
	const folder = await openDirectoryHistory({ root, git: { author } });
	try {
		expect(
			(await folder.write('audio/take.wav', 'Private audio')).error,
		).toBeNull();
		expect((await folder.write('note.md', 'Shared')).error).toBeNull();
		expect((await folder.git.commit()).status).toBe('committed');
		expect(await git(root, 'ls-files')).toBe('note.md');
	} finally {
		await folder.close();
	}
});

test('Finder files use ordinary Git rules and tracked ones remain tracked', async () => {
	const root = await scratch('scope-finder-');
	const folder = await openDirectoryHistory({ root, git: { author } });
	try {
		expect((await folder.write('.DS_Store', 'Original')).error).toBeNull();
		expect((await folder.git.commit()).status).toBe('committed');
		expect((await folder.write('.gitignore', '.DS_Store\n')).error).toBeNull();
		expect((await folder.write('.DS_Store', 'Updated')).error).toBeNull();
		expect((await folder.write('notes/.DS_Store', 'Ignored')).error).toBeNull();
		expect((await folder.git.commit()).status).toBe('committed');
		expect(await git(root, 'ls-files')).toBe('.DS_Store\n.gitignore');
		expect(await git(root, 'show', 'HEAD:.DS_Store')).toBe('Updated');
	} finally {
		await folder.close();
	}
});
