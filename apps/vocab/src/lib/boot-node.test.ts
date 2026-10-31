/**
 * Vocab acquisition boundary tests.
 * The variant's root is the one place that decides the store: on the web
 * the signed-in root sets the learner's repository, on the desktop
 * `Startup` opens the data folder; the page passes that client to the app;
 * callback pages and ancestor layouts open nothing; and no web source opens
 * a store in the browser. Which leaves each build carries is
 * `platform.test.ts`'s.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('../..', import.meta.url));
const source = join(appRoot, 'src');
const routes = join(source, 'routes');
const components = join(source, 'lib/components');
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

/** The desktop window's own sources, which open its folder. */
const desktopOnly = /\.tauri\.ts$|components\/(Startup|Desktop\w+)\.svelte$/;

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

	test('callback and ancestor layouts never open a store or mount the app', async () => {
		for (const file of [callback, ...ancestorLayouts(callback)]) {
			const text = await Bun.file(file).text();
			expect(text).not.toMatch(/openDevice\s*\(|openRemote\s*\(/);
			expect(text).not.toMatch(/@epicenter\/folder/);
			expect(text).not.toMatch(/VocabApp\.svelte|Online\.svelte/);
		}
	});
});

describe('the variant root decides the one store', () => {
	test('the layout renders the variant’s Startup under its boundary, and the page passes its store', async () => {
		const layout = await Bun.file(join(routes, '(app)/+layout.svelte')).text();
		expect(layout).toMatch(/import \{ Startup \} from '#platform\/root'/);
		expect(layout).toMatch(
			/<svelte:boundary>[\s\S]*<Startup>\{@render children\(\)\}<\/Startup>/,
		);
		const page = await Bun.file(join(routes, '(app)/+page.svelte')).text();
		expect(page).toMatch(/const vocab = store\(\);/);
		expect(page).toMatch(/<VocabApp \{vocab\} \/>/);
	});

	test('on the web, signed in, the root sets the repository for the account; signed out, it asks for a sign-in', async () => {
		const root = await Bun.file(join(components, 'OnlineRoot.svelte')).text();
		expect(root).toMatch(
			/\{#if auth\.state\.status !== 'signed-out'\}\s*\{#key auth\.state\.account\}\s*<Online account=\{auth\.state\.account\}>/,
		);
		const online = await Bun.file(join(components, 'Online.svelte')).text();
		expect(online).toMatch(
			/setRepo\(fromClient\(openRemote\(vocab, \{ account \}\)\)\)/,
		);
		const leaf = await Bun.file(join(source, 'lib/root.ts')).text();
		expect(leaf).toMatch(/getRepo<Vocab>\(\)/);
	});

	test('on the desktop, Startup opens the AppData root, then the data folder', async () => {
		const startup = await Bun.file(join(components, 'Startup.svelte')).text();
		expect(startup).toMatch(/openAppData\(vocabSettings\)/);
		expect(startup).toMatch(
			/openDataFolder\(vocab, \{ appData: appData\.data \}\)/,
		);
	});

	test('the contract declares no account', async () => {
		const contract = await Bun.file(join(source, 'lib/contract.ts')).text();
		expect(contract).not.toMatch(/accountKey|@epicenter\/auth/);
	});

	test('no web source opens a store in the browser: the repository is the only one', async () => {
		const files = (await shippedSources()).filter(
			({ path }) => !desktopOnly.test(path),
		);
		const openers = files
			.filter(({ text }) =>
				/@epicenter\/app\/(open|store|memory)|@epicenter\/folder\/browser|\bopenDevice\b|\bopenLocal\b|\bopenPersonal\b|PersistenceNotice|fromData\b/.test(
					text,
				),
			)
			.map(({ path }) => path);
		expect(openers).toEqual([]);
	});
});
