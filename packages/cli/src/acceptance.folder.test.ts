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
				await folder.write(page + '.md', page);
			},
		}),
		context: defineAction({
			description: 'Name where the folder is, and keep a local index',
			input: {},
			run: async () => {
				const { Database } = await import('bun:sqlite');
				await folder.write('seen.local.txt', 'local');
				const db = new Database(folder.path + '/index.local.sqlite');
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
	const folder = await f.folder(join(f.home, 'journal'), journal);
	const result = await f.run('journal', 'context', '--json');
	expect(result.code).toBe(0);
	expect(JSON.parse(result.stdout)).toEqual({ returned: folder });
	expect(existsSync(join(folder, 'index.local.sqlite'))).toBe(true);
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
		'page.md': 'base\n',
	});
	const bare = join(f.root, `${name}.git`);
	await gitIn(f.root, 'clone', '-q', '--bare', seed, bare);
	const folder = join(f.home, name);
	await gitIn(f.root, 'clone', '-q', bare, folder);
	const peer = join(f.root, `${name}-peer`);
	await gitIn(f.root, 'clone', '-q', bare, peer);
	const peerCommits = async (path: string, text: string) => {
		await writeFile(join(peer, path), text);
		await gitIn(peer, 'add', path);
		await gitIn(peer, 'commit', '-q', '-m', `peer ${path}`);
		await gitIn(peer, 'push', '-q');
	};
	return { folder, bare, peerCommits };
}

test('W2 epicenter sync snapshots and pushes to a bare origin without fetching', async () => {
	const f = await setup();
	const journal = await withOrigin(f, 'journal');
	await writeFile(join(journal.folder, 'monday.md'), 'monday\n');
	await writeFile(join(journal.folder, 'tuesday.md'), 'tuesday\n');
	await f.folder(join(f.home, 'notes'), {
		'.gitignore': gitignore,
		'epicenter.ts': bareApp('notes'),
	});
	await writeFile(join(f.home, 'notes', 'kept.md'), 'kept\n');

	const synced = await f.run('sync', '--json');
	expect(synced.code).toBe(0);
	expect(JSON.parse(synced.stdout)).toEqual({
		apps: [
			{
				app: 'journal',
				folder: journal.folder,
				committed: { subject: 'journal: changed outside epicenter', files: 2 },
				pushed: true,
				origin: { ahead: 0, behind: 0 },
			},
			{
				app: 'notes',
				folder: join(f.home, 'notes'),
				committed: { subject: 'notes: changed outside epicenter', files: 1 },
				pushed: false,
				origin: null,
			},
		],
	});
	expect(await gitIn(journal.bare, 'log', '--format=%s')).toBe(
		'journal: changed outside epicenter\ninitial',
	);
	expect(await gitIn(join(f.home, 'notes'), 'status', '--porcelain')).toBe('');

	const again = await f.run('sync', 'journal');
	expect(again.code).toBe(0);
	expect(again.stdout).toBe(
		'journal: nothing to commit; pushed; 0 ahead of origin, 0 behind\n',
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
	await clash.peerCommits('page.md', 'the laptop says\n');
	await writeFile(join(clash.folder, 'page.md'), 'the desk says\n');
	const offline = await withOrigin(f, 'offline');
	await writeFile(join(offline.folder, 'note.md'), 'written offline\n');
	await gitIn(
		offline.folder,
		'remote',
		'set-url',
		'--push',
		'origin',
		join(f.root, 'gone.git'),
	);
	await f.folder(
		join(f.home, 'loose'),
		{ 'epicenter.ts': bareApp('loose') },
		{ git: false },
	);
	const fine = await withOrigin(f, 'fine');
	await writeFile(join(fine.folder, 'new.md'), 'new\n');

	const synced = await f.run('sync', '--json');
	expect(synced.code).toBe(1);
	const apps = Object.fromEntries(
		JSON.parse(synced.stdout).apps.map((app: { app: string }) => [
			app.app,
			app,
		]),
	);
	expect(apps.clash).toMatchObject({
		committed: { subject: 'clash: changed outside epicenter' },
		pushed: false,
		origin: { ahead: 1, behind: 0 },
		error: {
			message: expect.stringContaining('nothing was overwritten'),
			next: `git -C ${clash.folder} fetch origin && git -C ${clash.folder} log HEAD..origin/main`,
		},
	});
	expect(
		await gitIn(clash.folder, 'rev-parse', 'refs/remotes/origin/main'),
	).toBe(await gitIn(clash.folder, 'rev-parse', 'HEAD~1'));
	expect(await gitIn(clash.bare, 'log', '-1', '--format=%s')).toBe(
		'peer page.md',
	);
	expect(await gitIn(clash.folder, 'log', '-1', '--format=%s')).toBe(
		'clash: changed outside epicenter',
	);
	expect(await readFile(join(clash.folder, 'page.md'), 'utf8')).toBe(
		'the desk says\n',
	);
	expect(await gitIn(clash.folder, 'status', '--porcelain')).toBe('');
	expect(apps.offline).toMatchObject({
		committed: { files: 1 },
		pushed: false,
		error: {
			message: expect.stringContaining('not pushed'),
			next: `git -C ${offline.folder} push origin HEAD:main`,
		},
	});
	expect(apps.loose).toMatchObject({
		committed: null,
		pushed: false,
		origin: null,
		error: { message: expect.stringContaining('not a git repository') },
	});
	expect(apps.fine).toMatchObject({
		pushed: true,
		origin: { ahead: 0, behind: 0 },
	});
	await writeFile(join(clash.folder, 'still-pending.md'), 'pending\n');
	const status = JSON.parse((await f.run('clash', '--json')).stdout);
	expect(status.status).toEqual({ pending: 1, unpushed: 1 });
	const listed = await f.run();
	expect(listed.stdout).toContain(
		'(1 change not yet in history; 1 snapshot not backed up)',
	);
	expect(listed.stdout).toContain('Run: epicenter sync clash');

	const human = await f.run('sync');
	expect(human.code).toBe(1);
	expect(human.stderr).toContain(
		`Run: git -C ${clash.folder} fetch origin && git -C ${clash.folder} log HEAD..origin/main`,
	);
});

test('W3 sync of an app inside a larger repository snapshots only its folder', async () => {
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
	await symlink(join(vault, 'recipes'), join(f.home, 'recipes'));
	await writeFile(join(vault, 'journal/today.md'), 'changed beside\n');
	await writeFile(join(vault, 'recipes/bread.md'), 'bread\n');
	const synced = await f.run('sync', 'recipes', '--json');
	expect(synced.code).toBe(0);
	expect(JSON.parse(synced.stdout).apps[0]).toMatchObject({
		committed: { subject: 'recipes: changed outside epicenter' },
		pushed: true,
	});
	expect(await gitIn(bare, 'show', '--name-only', '--format=', 'HEAD')).toBe(
		'recipes/bread.md',
	);
	expect(await gitIn(vault, 'diff', '--name-only')).toBe('journal/today.md');
	expect(await gitIn(vault, 'diff', '--cached', '--name-only')).toBe('');
	expect(existsSync(join(vault, 'peer.md'))).toBe(false);
});

test('W4 epicenter new writes the template and runs git init', async () => {
	const f = await setup();
	const result = await f.run('new', 'garden', '--json');
	expect(result.code).toBe(0);
	const folder = join(f.home, 'garden');
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
		{ 'epicenter.ts': bareApp('loose'), 'notes/a.md': 'a\n' },
		{ git: false },
	);
	await symlink(loose, join(f.home, 'loose'));
	expect((await lstat(join(f.home, 'loose'))).isSymbolicLink()).toBe(true);
	expect(await readlink(join(f.home, 'loose'))).toBe(loose);
	expect(existsSync(join(loose, '.git'))).toBe(false);
	expect(existsSync(join(loose, '.gitignore'))).toBe(false);

	const vault = await f.folder(join(f.root, 'Code', 'vault'), {
		'recipes/epicenter.ts': bareApp('recipes'),
		'journal/today.md': 'today\n',
	});
	const head = await gitIn(vault, 'rev-parse', 'HEAD');
	await writeFile(join(vault, 'recipes', 'soup.md'), 'soup\n');
	await symlink(join(vault, 'recipes'), join(f.home, 'recipes'));
	expect(await readlink(join(f.home, 'recipes'))).toBe(join(vault, 'recipes'));
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

test('W3 a refused push leaves changes beside the app and creates no stash', async () => {
	const f = await setup();
	const seed = await f.folder(join(f.root, 'vault-seed'), {
		'journal/today.md': 'today\n',
		'recipes/epicenter.ts': bareApp('recipes'),
	});
	const bare = join(f.root, 'vault.git');
	await gitIn(f.root, 'clone', '-q', '--bare', seed, bare);
	const vault = join(f.root, 'vault');
	await gitIn(f.root, 'clone', '-q', bare, vault);
	await symlink(join(vault, 'recipes'), join(f.home, 'recipes'));
	const peer = join(f.root, 'vault-peer');
	await gitIn(f.root, 'clone', '-q', bare, peer);
	await writeFile(join(peer, 'journal/today.md'), 'the laptop\n');
	await gitIn(peer, 'commit', '-q', '-am', 'peer');
	await gitIn(peer, 'push', '-q');

	await writeFile(join(vault, 'journal/today.md'), 'the desk\n');
	await writeFile(join(vault, 'recipes/bread.md'), 'bread\n');
	const synced = await f.run('sync', 'recipes', '--json');
	expect(synced.code).toBe(1);
	expect(JSON.parse(synced.stdout).apps[0]).toMatchObject({
		pushed: false,
		error: {
			message: expect.stringContaining('nothing was overwritten'),
		},
	});
	expect(await gitIn(vault, 'stash', 'list')).toBe('');
	expect(await readFile(join(vault, 'journal/today.md'), 'utf8')).toBe(
		'the desk\n',
	);
	expect(await gitIn(bare, 'log', '-1', '--format=%s')).toBe('peer');
});
