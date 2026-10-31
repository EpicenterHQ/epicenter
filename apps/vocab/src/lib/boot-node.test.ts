/**
 * Vocab acquisition boundary tests.
 * The signed-in layout is the one root that decides the store, the learner's
 * repository; the page passes that client to the app; callback pages and
 * ancestor layouts open nothing; and no shipped source opens a store in the
 * browser.
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

	test('callback and ancestor layouts never open a store or mount the app', async () => {
		for (const file of [callback, ...ancestorLayouts(callback)]) {
			const text = await Bun.file(file).text();
			expect(text).not.toMatch(/openDevice\s*\(|openRemote\s*\(/);
			expect(text).not.toMatch(/@epicenter\/folder/);
			expect(text).not.toMatch(/VocabApp\.svelte|Online\.svelte/);
		}
	});
});

describe('the repository is the one store', () => {
	test('signed in, the layout sets the repository for the account; signed out, it asks for a sign-in', async () => {
		const layout = await Bun.file(join(routes, '(app)/+layout.svelte')).text();
		expect(layout).toMatch(
			/\{#if auth\.state\.status !== 'signed-out'\}\s*\{#key auth\.state\.account\}\s*<Online account=\{auth\.state\.account\}>/,
		);
		expect(layout).toMatch(/Sign in to use the words and chats/);
		const online = await Bun.file(
			join(routes, 'components/Online.svelte'),
		).text();
		expect(online).toMatch(/setRepo\(openRemote\(vocab, \{ account \}\)\)/);
		const page = await Bun.file(join(routes, '(app)/+page.svelte')).text();
		expect(page).toMatch(
			/<VocabApp vocab=\{fromClient\(getRepo<Vocab>\(\)\)\}/,
		);
	});

	test('the contract declares no account', async () => {
		const contract = await Bun.file(join(source, 'lib/contract.ts')).text();
		expect(contract).not.toMatch(/accountKey|@epicenter\/auth/);
	});

	test('no shipped source opens a store in the browser: the repository is the only one', async () => {
		const files = await shippedSources();
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
