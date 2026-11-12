/**
 * Acceptance, stage 3: the folder and `epicenter sync` (ADR-0851, ADR-0852,
 * ADR-0854). Black-box runs of the real `epicenter` against a temporary HOME,
 * with bare repositories in temporary folders standing in for `origin` and
 * for a shared app.
 */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync } from 'node:fs';
import {
	lstat,
	mkdir,
	readFile,
	readlink,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
	bareApp,
	fixture,
	gitIn,
	gitignore,
	header,
} from './runner.test-support.ts';

setDefaultTimeout(60_000);

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});
async function setup() {
	const f = await fixture();
	roots.push(f.root);
	return f;
}

const journalCode = `${header}
export default defineApp({
	description: 'The journal app',
	collections: {},
	actions: {
		write: defineAction({
			description: 'Write a page',
			input: { page: field.text() },
			positional: ['page'],
			run: async ({ page }) => {
				await folder.write('data/' + page + '.md', page);
			},
		}),
		context: defineAction({
			description: 'Name where the folder is, and keep a local index',
			input: {},
			run: async () => {
				const { Database } = await import('bun:sqlite');
				await folder.write('data/seen.local.txt', 'local');
				const db = new Database(folder.path + '/data/index.local.sqlite');
				db.run('CREATE TABLE IF NOT EXISTS pages (name TEXT)');
				db.close();
				return folder.path;
			},
		}),
	},
});
`;

const journal = {
	'.gitignore': gitignore,
	'epicenter.ts': journalCode,
};

test("W1 local files stay in the folder, and folder.path is the app's folder on disk", async () => {
	const f = await setup();
	const folder = await f.folder(join(f.apps, 'journal'), journal);
	const result = await f.run('journal', 'context', '--json');
	expect(result.code).toBe(0);
	expect(JSON.parse(result.stdout)).toEqual({ returned: folder });
	expect(existsSync(join(folder, 'data/index.local.sqlite'))).toBe(true);
	expect(await gitIn(folder, 'status', '--porcelain')).toBe('');
	// Bun keeps its own transpiler cache under ~/Library/Caches/bun; epicenter keeps none there.
	expect(existsSync(join(f.root, 'Library/Caches/so.epicenter.apps'))).toBe(
		false,
	);
	expect((await f.run('--help')).stdout).not.toContain('EPICENTER_CACHE_HOME');
	expect(
		JSON.parse((await f.run('journal', '--json')).stdout),
	).not.toHaveProperty('cache');
});

/** A clone of a bare `origin`, in the home as `name`, and a peer clone that pushes to the same origin. */
async function withOrigin(f: Awaited<ReturnType<typeof setup>>, name: string) {
	const seed = await f.folder(join(f.root, `${name}-seed`), {
		'.gitignore': gitignore,
		'epicenter.ts': bareApp(name),
	});
	const codeBare = join(f.root, `${name}-code.git`);
	await gitIn(f.root, 'clone', '-q', '--bare', seed, codeBare);
	const seedData = join(seed, 'data');
	await mkdir(seedData);
	await writeFile(join(seedData, '.gitignore'), '*.local\n*.local.*\n');
	await writeFile(join(seedData, 'page.md'), 'base\n');
	await gitIn(seedData, 'init', '-q');
	await gitIn(seedData, 'add', '.');
	await gitIn(seedData, 'commit', '-q', '-m', `${name}: start its data`);
	const bare = join(f.root, `${name}-data.git`);
	await gitIn(f.root, 'clone', '-q', '--bare', seedData, bare);
	const folder = join(f.apps, name);
	await gitIn(f.root, 'clone', '-q', codeBare, folder);
	await gitIn(f.root, 'clone', '-q', bare, join(folder, 'data'));
	const peer = join(f.root, `${name}-peer`);
	await gitIn(f.root, 'clone', '-q', bare, peer);
	const peerCommits = async (path: string, text: string) => {
		const inData = path.replace(/^data\//, '');
		await writeFile(join(peer, inData), text);
		await gitIn(peer, 'add', inData);
		await gitIn(peer, 'commit', '-q', '-m', `peer ${path}`);
		await gitIn(peer, 'push', '-q');
	};
	return { folder, bare, peerCommits };
}

test('W2 epicenter sync snapshots and pushes to a bare origin without fetching', async () => {
	const f = await setup();
	const journal = await withOrigin(f, 'journal');
	await writeFile(join(journal.folder, 'data/monday.md'), 'monday\n');
	await writeFile(join(journal.folder, 'data/tuesday.md'), 'tuesday\n');
	await f.folder(join(f.apps, 'notes'), {
		'.gitignore': gitignore,
		'epicenter.ts': bareApp('notes'),
	});
	await mkdir(join(f.apps, 'notes', 'data'));
	await writeFile(join(f.apps, 'notes', 'data/kept.md'), 'kept\n');

	const synced = await f.run('sync', '--json');
	expect(synced.code).toBe(0);
	expect(JSON.parse(synced.stdout)).toEqual({
		apps: [
			{
				app: 'journal',
				folder: journal.folder,
				code: { committed: null, pushed: false, origin: { ahead: 0 } },
				data: {
					committed: {
						subject: 'journal: changed outside epicenter',
						files: 2,
					},
					pushed: true,
					origin: { ahead: 0 },
				},
			},
			{
				app: 'notes',
				folder: join(f.apps, 'notes'),
				code: { committed: null, pushed: false, origin: null },
				data: {
					committed: { subject: 'notes: changed outside epicenter', files: 1 },
					pushed: false,
					origin: null,
				},
			},
		],
	});
	expect(await gitIn(journal.bare, 'log', '--format=%s')).toBe(
		'journal: changed outside epicenter\njournal: start its data',
	);
	expect(await gitIn(join(f.apps, 'notes'), 'status', '--porcelain')).toBe('');

	const again = await f.run('sync', 'journal');
	expect(again.code).toBe(0);
	expect(again.stdout).toBe(
		'journal: nothing to commit; 0 ahead of origin\njournal/data: nothing to commit; 0 ahead of origin\n',
	);
	expect(again.stderr).toBe('');
	expect((await f.run('sync', 'nope', '--json')).code).toBe(2);

	// The listing says nothing of origin.
	const listed = JSON.parse((await f.run('--json')).stdout);
	expect(listed.apps[0]).not.toHaveProperty('origin');
});

test('W3 a refused push leaves both sides unchanged and other apps still sync', async () => {
	const f = await setup();
	const clash = await withOrigin(f, 'clash');
	await clash.peerCommits('data/page.md', 'the laptop says\n');
	await writeFile(join(clash.folder, 'data/page.md'), 'the desk says\n');
	const offline = await withOrigin(f, 'offline');
	await writeFile(join(offline.folder, 'data/note.md'), 'written offline\n');
	await gitIn(
		join(offline.folder, 'data'),
		'remote',
		'set-url',
		'--push',
		'origin',
		join(f.root, 'gone.git'),
	);
	await f.folder(
		join(f.apps, 'loose'),
		{ 'epicenter.ts': bareApp('loose') },
		{ git: false },
	);
	const fine = await withOrigin(f, 'fine');
	await writeFile(join(fine.folder, 'data/new.md'), 'new\n');

	const synced = await f.run('sync', '--json');
	expect(synced.code).toBe(1);
	const apps = Object.fromEntries(
		JSON.parse(synced.stdout).apps.map((app: { app: string }) => [
			app.app,
			app,
		]),
	);
	expect(apps.clash).toMatchObject({
		data: {
			committed: { subject: 'clash: changed outside epicenter' },
			pushed: false,
			origin: { ahead: 1 },
			error: {
				message: expect.stringContaining('nothing was overwritten'),
				next: `git -C ${clash.folder}/data fetch origin && git -C ${clash.folder}/data log HEAD..origin/main`,
			},
		},
	});
	expect(
		await gitIn(
			join(clash.folder, 'data'),
			'rev-parse',
			'refs/remotes/origin/main',
		),
	).toBe(await gitIn(join(clash.folder, 'data'), 'rev-parse', 'HEAD~1'));
	expect(await gitIn(clash.bare, 'log', '-1', '--format=%s')).toBe(
		'peer data/page.md',
	);
	expect(
		await gitIn(join(clash.folder, 'data'), 'log', '-1', '--format=%s'),
	).toBe('clash: changed outside epicenter');
	expect(await readFile(join(clash.folder, 'data/page.md'), 'utf8')).toBe(
		'the desk says\n',
	);
	expect(await gitIn(clash.folder, 'status', '--porcelain')).toBe('');
	expect(apps.offline).toMatchObject({
		data: {
			committed: { files: 1 },
			pushed: false,
			error: {
				message: expect.stringContaining('not pushed'),
				next: `git -C ${offline.folder}/data push origin HEAD:main`,
			},
		},
	});
	expect(apps.loose).toMatchObject({
		code: null,
		data: null,
	});
	expect(apps.fine).toMatchObject({
		data: { pushed: true, origin: { ahead: 0 } },
	});
	await writeFile(join(clash.folder, 'data/still-pending.md'), 'pending\n');
	const status = JSON.parse((await f.run('clash', '--json')).stdout);
	expect(status.status).toMatchObject({ data: { pending: 1, unpushed: 1 } });
	const listed = await f.run();
	expect(listed.stdout).toContain(
		'data: 1 change not yet in history; data: 1 snapshot not backed up',
	);
	expect(listed.stdout).toContain('Run: epicenter sync clash');

	const human = await f.run('sync');
	expect(human.code).toBe(1);
	expect(human.stderr).toContain(
		`Run: git -C ${clash.folder}/data fetch origin && git -C ${clash.folder}/data log HEAD..origin/main`,
	);
});

test('W3 sync of an app inside a larger repository commits data without touching the larger repository', async () => {
	const f = await setup();
	const seed = await f.folder(join(f.root, 'vault-seed'), {
		'journal/today.md': 'today\n',
		'recipes/epicenter.ts': bareApp('recipes'),
		'recipes/soup.md': 'soup\n',
	});
	const bare = join(f.root, 'vault.git');
	await gitIn(f.root, 'clone', '-q', '--bare', seed, bare);
	const vault = join(f.root, 'vault');
	await gitIn(f.root, 'clone', '-q', bare, vault);
	await symlink(join(vault, 'recipes'), join(f.apps, 'recipes'));
	await writeFile(join(vault, 'journal/today.md'), 'changed beside\n');
	await writeFile(join(vault, 'recipes/bread.md'), 'bread\n');
	await mkdir(join(vault, 'recipes', 'data'));
	await writeFile(join(vault, 'recipes', 'data', 'page.md'), 'page\n');
	const head = await gitIn(vault, 'rev-parse', 'HEAD');
	const synced = await f.run('sync', 'recipes', '--json');
	expect(synced.code).toBe(0);
	expect(JSON.parse(synced.stdout).apps[0]).toMatchObject({
		code: null,
		data: {
			committed: { subject: 'recipes: changed outside epicenter' },
			pushed: false,
		},
	});
	expect(
		await gitIn(
			join(vault, 'recipes', 'data'),
			'show',
			'--name-only',
			'--format=',
			'HEAD',
		),
	).toBe('page.md');
	expect(await gitIn(vault, 'rev-parse', 'HEAD')).toBe(head);
	expect(await gitIn(bare, 'rev-parse', 'HEAD')).toBe(head);
	expect(await gitIn(vault, 'diff', '--name-only')).toBe('journal/today.md');
	expect(await gitIn(vault, 'diff', '--cached', '--name-only')).toBe('');
	expect(await readFile(join(vault, 'recipes', 'bread.md'), 'utf8')).toBe(
		'bread\n',
	);
});

test('W4 epicenter new writes the template and runs git init', async () => {
	const f = await setup();
	const result = await f.run('new', 'garden', '--json');
	expect(result.code).toBe(0);
	const folder = join(f.apps, 'garden');
	expect(JSON.parse(result.stdout)).toEqual({ name: 'garden', folder });
	expect(await readFile(join(folder, 'epicenter.ts'), 'utf8')).toBe(
		`import { defineApp } from '@epicenter/app';

export default defineApp({
	description: 'Describe garden',
	collections: {},
	actions: {},
});
`,
	);
	expect(existsSync(join(folder, 'epicenter.json'))).toBe(false);
	expect(await readFile(join(folder, '.gitignore'), 'utf8')).toBe(gitignore);
	expect(existsSync(join(folder, '.gitattributes'))).toBe(false);
	expect(await gitIn(folder, 'log', '--format=%s')).toBe('new garden');
	expect(await gitIn(join(folder, 'data'), 'log', '--format=%s')).toBe(
		'garden: start its data',
	);
	expect(await gitIn(folder, 'status', '--porcelain')).toBe('');
	const listed = JSON.parse((await f.run('--json')).stdout);
	expect(listed.apps).toMatchObject([
		{ name: 'garden', description: 'Describe garden', actions: [] },
	]);
});

test('W5 a symlinked entry loads an app where it lives', async () => {
	const f = await setup();
	const loose = await f.folder(
		join(f.root, 'Code', 'loose'),
		{ 'epicenter.ts': bareApp('loose'), 'data/notes/a.md': 'a\n' },
		{ git: false },
	);
	await symlink(loose, join(f.apps, 'loose'));
	expect((await lstat(join(f.apps, 'loose'))).isSymbolicLink()).toBe(true);
	expect(await readlink(join(f.apps, 'loose'))).toBe(loose);
	expect(existsSync(join(loose, '.git'))).toBe(false);
	expect(existsSync(join(loose, '.gitignore'))).toBe(false);

	const vault = await f.folder(join(f.root, 'Code', 'vault'), {
		'recipes/epicenter.ts': bareApp('recipes'),
		'journal/today.md': 'today\n',
	});
	const head = await gitIn(vault, 'rev-parse', 'HEAD');
	await writeFile(join(vault, 'recipes', 'soup.md'), 'soup\n');
	await symlink(join(vault, 'recipes'), join(f.apps, 'recipes'));
	expect(await readlink(join(f.apps, 'recipes'))).toBe(join(vault, 'recipes'));
	expect(await gitIn(vault, 'rev-parse', 'HEAD')).toBe(head);
	expect(await gitIn(vault, 'status', '--porcelain')).toBe(
		'?? recipes/soup.md',
	);

	const listed = JSON.parse((await f.run('--json')).stdout);
	expect(listed.apps.map((app: { name: string }) => app.name)).toEqual([
		'loose',
		'recipes',
	]);
	expect((await f.run('loose', '--json')).code).toBe(0);
});

test('W3 a divergent parent remote leaves data sync and changes beside the app alone', async () => {
	const f = await setup();
	const seed = await f.folder(join(f.root, 'vault-seed'), {
		'journal/today.md': 'today\n',
		'recipes/epicenter.ts': bareApp('recipes'),
	});
	const bare = join(f.root, 'vault.git');
	await gitIn(f.root, 'clone', '-q', '--bare', seed, bare);
	const vault = join(f.root, 'vault');
	await gitIn(f.root, 'clone', '-q', bare, vault);
	await symlink(join(vault, 'recipes'), join(f.apps, 'recipes'));
	const peer = join(f.root, 'vault-peer');
	await gitIn(f.root, 'clone', '-q', bare, peer);
	await writeFile(join(peer, 'journal/today.md'), 'the laptop\n');
	await gitIn(peer, 'commit', '-q', '-am', 'peer');
	await gitIn(peer, 'push', '-q');

	await writeFile(join(vault, 'journal/today.md'), 'the desk\n');
	await writeFile(join(vault, 'recipes/bread.md'), 'bread\n');
	await mkdir(join(vault, 'recipes', 'data'));
	await writeFile(join(vault, 'recipes', 'data', 'page.md'), 'page\n');
	const head = await gitIn(vault, 'rev-parse', 'HEAD');
	const synced = await f.run('sync', 'recipes', '--json');
	expect(synced.code).toBe(0);
	expect(JSON.parse(synced.stdout).apps[0]).toMatchObject({
		code: null,
		data: {
			committed: { subject: 'recipes: changed outside epicenter' },
			pushed: false,
		},
	});
	expect(
		await gitIn(
			join(vault, 'recipes', 'data'),
			'show',
			'--name-only',
			'--format=',
			'HEAD',
		),
	).toBe('page.md');
	expect(await gitIn(vault, 'rev-parse', 'HEAD')).toBe(head);
	expect(await gitIn(vault, 'diff', '--cached', '--name-only')).toBe('');
	expect(await gitIn(vault, 'stash', 'list')).toBe('');
	expect(await readFile(join(vault, 'journal/today.md'), 'utf8')).toBe(
		'the desk\n',
	);
	expect(await gitIn(bare, 'log', '-1', '--format=%s')).toBe('peer');
});
