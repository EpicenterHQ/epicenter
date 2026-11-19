/** Container folder paths keep records rooted beside code/. */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, header } from './runner.test-support.ts';

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
