/**
 * Vocab acquisition boundary tests.
 * The working page opens the folder with no sign-in in front of it; callback
 * pages and ancestor layouts open nothing; and no shipped source opens an
 * account-based or device store from `@epicenter/app`.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('../..', import.meta.url));
const source = join(appRoot, 'src');
const routes = join(source, 'routes');
const callback = join(routes, 'auth/callback/+page.svelte');

function ancestorLayouts(page: string): string[] {
	const found: string[] = [];
	for (
		let directory = dirname(page);
		directory.startsWith(routes);
		directory = dirname(directory)
	) {
		const layout = join(directory, '+layout.svelte');
		if (existsSync(layout)) found.push(layout);
	}
	return found;
}

/** Every shipped source file: no tests and no test support. */
async function shippedSources(): Promise<{ path: string; text: string }[]> {
	const names = await readdir(source, { recursive: true });
	const files = names.filter(
		(name) =>
			/\.(ts|svelte)$/.test(name) && !/\.(test|test-support)\.ts$/.test(name),
	);
	return Promise.all(
		files.map(async (name) => ({
			path: relative(source, join(source, name)),
			text: await Bun.file(join(source, name)).text(),
		})),
	);
}

describe('the callback opens nothing', () => {
	test('the callback page exists and has at least one ancestor layout', () => {
		expect(existsSync(callback)).toBe(true);
		expect(ancestorLayouts(callback).length).toBeGreaterThan(0);
	});

	test('callback and ancestor layouts never open the folder or mount the app', async () => {
		for (const file of [callback, ...ancestorLayouts(callback)]) {
			const text = await Bun.file(file).text();
			expect(text).not.toMatch(/FolderApp|openFolder\s*\(/);
			expect(text).not.toMatch(/@epicenter\/folder/);
			expect(text).not.toContain('VocabApp.svelte');
		}
	});
});

describe('the working page needs no account', () => {
	test('the page opens the local folder and mounts the app with no sign-in gate', async () => {
		const page = await Bun.file(join(routes, '+page.svelte')).text();
		expect(page).toContain('<FolderApp ');
		expect(page).toMatch(/openFolder\(\{\s*tables:\s*vocabTables\s*\}\)/);
		expect(page).toMatch(/<VocabApp\b/);
		expect(page).not.toMatch(/AppBoot|SignInScreen|\$lib\/auth/);
	});

	test('the tables declare no account', async () => {
		const declaration = await Bun.file(join(source, 'lib/data.ts')).text();
		expect(declaration).not.toMatch(/accountKey|@epicenter\/auth/);
	});

	test('no shipped source opens the declared folder of the older shape', async () => {
		const files = await shippedSources();
		const legacy = files
			.filter(({ text }) =>
				/\bdefineFolder\b|\bLegacyFolder\b|openFolder\(\{\s*(app|id)\b/.test(
					text,
				),
			)
			.map(({ path }) => path);
		expect(legacy).toEqual([]);
	});

	test('no shipped source opens a store: the folder is the only saved data', async () => {
		const files = await shippedSources();
		const openers = files
			.filter(({ text }) =>
				/@epicenter\/app\/(open|store|memory)|\bopenLocal\b|\bopenPersonal\b|PersistenceNotice|fromData\b/.test(
					text,
				),
			)
			.map(({ path }) => path);
		expect(openers).toEqual([]);
	});
});
