/**
 * Local Pattern Tests
 *
 * A definition's `local` patterns name files that stay on the machine that
 * wrote them. A directory's history leaves the files they match out of what
 * Sync commits and sends, whatever `.gitignore` says.
 *
 * Key behaviors:
 * - Patterns that cannot be one ignoring line are refused at the declaration
 * - Sync sends the rows and never a local file: not without a `.gitignore`,
 *   and not past a person's `!` exception
 *
 * See also:
 * - `local-declaration.test.ts` for `local` read from `epicenter.json` by
 *   `runHistory`, and a file committed before the rule
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expectOk } from 'wellcrafted/testing';
import { defineFolder, defineTable, field } from './bun.js';
import { openDirectoryHistory } from './directory-history.test-support.js';
import {
	GIT_ENV,
	git,
	initWithOrigin,
	scratch,
} from './git-http.test-support.js';

const tables = {
	recordings: defineTable({ fields: { title: field.string() } }),
};
const definition = defineFolder({ tables, local: ['audio/'] });
const author = { name: 'Recorder', email: 'recorder@example.test' };
const originalGlobal = process.env.GIT_CONFIG_GLOBAL;
const roots: string[] = [];

beforeAll(() => {
	process.env.GIT_CONFIG_GLOBAL = GIT_ENV.GIT_CONFIG_GLOBAL;
});
afterAll(() => {
	if (originalGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
	else process.env.GIT_CONFIG_GLOBAL = originalGlobal;
});
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

for (const [name, local] of [
	['a comment', ['# audio']],
	['a negation', ['!recordings/*.md']],
	['two lines', ['a\nb']],
	['surrounding whitespace', [' recordings/ ']],
	['an empty pattern', ['']],
] as const)
	test(`${name} is refused at the declaration`, () => {
		expect(() => defineFolder({ tables: {}, local: [...local] })).toThrow();
	});

/** A directory with a recording's row and audio, syncing to a bare remote on disk. */
async function recorded(files: Record<string, string> = {}) {
	const root = await scratch('local-native-');
	roots.push(root);
	const bare = join(root, 'remote.git');
	await git(root, 'init', '--quiet', '--bare', '--initial-branch=main', bare);
	const directory = join(root, 'folder');
	await initWithOrigin(directory, bare);
	for (const [path, text] of Object.entries({
		'recordings/walk.md': '---\ntitle: walk\n---\n',
		'audio/walk.wav': 'RIFF',
		...files,
	})) {
		await mkdir(dirname(join(directory, path)), { recursive: true });
		await writeFile(join(directory, path), text);
	}
	const folder = await openDirectoryHistory({
		root: directory,
		definition,
		git: { author },
	});
	const remoteTree = async () =>
		(await git(bare, 'ls-tree', '-r', '--name-only', 'main'))
			.split('\n')
			.sort();
	return { folder, remoteTree };
}

test('without a .gitignore, Sync still leaves the audio out', async () => {
	const { folder, remoteTree } = await recorded();
	try {
		expect(expectOk(await folder.sync.run())).toMatchObject({ kind: 'synced' });
		expect(await remoteTree()).toEqual(['recordings/walk.md']);
	} finally {
		await folder.close();
	}
});

test("a person's ! exception in .gitignore does not get the audio committed", async () => {
	// Plain `git add -A` would take audio/walk.wav.
	const { folder, remoteTree } = await recorded({
		'.gitignore': 'audio/*\n!audio/walk.wav\n',
	});
	try {
		expect(expectOk(await folder.sync.run())).toMatchObject({ kind: 'synced' });
		expect(await remoteTree()).toEqual(['.gitignore', 'recordings/walk.md']);
	} finally {
		await folder.close();
	}
});
