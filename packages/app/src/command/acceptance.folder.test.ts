/** Container folder paths and symlinked entries keep records rooted beside code/. */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { lstat, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bareApp, fixture, header } from './runner.test-support.ts';

setDefaultTimeout(60_000);

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});
async function setup() {
	const f = await fixture();
	roots.push(f.userDir);
	return f;
}

const journalCode = `${header}
export default defineApp(({ folder }) => ({
	description: 'The journal app',
	actions: {
		write: defineAction({
			description: 'Write a page',
			input: { page: field.text() },
			run: async ({ page }) => {
				await folder.write('data/' + page + '.md', page);
			 return Ok(undefined); },
		}),
		context: defineAction({
			description: 'Name where the folder is, and keep a local index',
			input: {},
			run: async () => {
				const { Database } = await import('bun:sqlite');
				await folder.write('local/seen.txt', 'local');
				const db = new Database(folder.path + '/local/index.sqlite');
				db.run('CREATE TABLE IF NOT EXISTS pages (name TEXT)');
				db.close();
				return Ok(folder.path);
			},
		}),
	},
}));
`;

const journal = {
	'code/epicenter.ts': journalCode,
};

test("W1 local files stay in the folder, and folder.path is the app's folder on disk", async () => {
	const f = await setup();
	const folder = await f.folder(join(f.apps, 'journal'), journal);
	const result = await f.run('journal', 'context', '--json');
	expect(result.code).toBe(0);
	expect(JSON.parse(result.stdout)).toEqual({ data: folder, error: null });
	expect(existsSync(join(folder, 'local/index.sqlite'))).toBe(true);

	// Bun keeps its own transpiler cache under ~/Library/Caches/bun; epicenter keeps none there.
	expect(existsSync(join(f.userDir, 'Library/Caches/so.epicenter.apps'))).toBe(
		false,
	);
	expect((await f.run('--help')).stdout).not.toContain('EPICENTER_CACHE_HOME');
	expect(
		JSON.parse((await f.run('journal', '--json')).stdout).data,
	).not.toHaveProperty('cache');
});

test('W5 a symlinked entry loads an app where it lives, when its code is inside the Epicenter', async () => {
	const f = await setup();
	const loose = await f.folder(join(f.epicenter, 'shelf', 'loose'), {
		'code/epicenter.ts': bareApp('loose'),
		'data/notes/a.md': 'a\n',
	});
	await symlink(loose, join(f.apps, 'loose'));
	expect((await lstat(join(f.apps, 'loose'))).isSymbolicLink()).toBe(true);
	expect(await readlink(join(f.apps, 'loose'))).toBe(loose);

	const vault = await f.folder(join(f.epicenter, 'shelf', 'vault'), {
		'recipes/code/epicenter.ts': bareApp('recipes'),
		'journal/today.md': 'today\n',
	});
	await writeFile(join(vault, 'recipes', 'soup.md'), 'soup\n');
	await symlink(join(vault, 'recipes'), join(f.apps, 'recipes'));
	expect(await readlink(join(f.apps, 'recipes'))).toBe(join(vault, 'recipes'));

	const listed = JSON.parse((await f.run('--json')).stdout).data;
	expect(listed.apps.map((app: { name: string }) => app.name)).toEqual([
		'loose',
		'recipes',
	]);
	expect((await f.run('loose', '--json')).code).toBe(0);

	// Code finds packages from where it really is, so code outside the Epicenter
	// does not find the Epicenter's @epicenter/app, and the listing gives Bun's
	// reason.
	const outside = await f.folder(join(f.userDir, 'Code', 'outside'), {
		'code/epicenter.ts': bareApp('outside'),
	});
	await symlink(outside, join(f.apps, 'outside'));
	expect(JSON.parse((await f.run('--json')).stdout).data.problems).toEqual([
		{
			entry: 'outside',
			folder: join(f.apps, 'outside'),
			problems: [
				`code/epicenter.ts: Cannot find package '@epicenter/app' imported from ${join(outside, 'code', 'epicenter.ts')}`,
			],
		},
	]);
});
