/**
 * Vocab acquisition boundary tests.
 * The working page opens this browser's files with no sign-in in front of
 * them; callback pages and ancestor layouts open nothing; and no shipped
 * source opens an account-based or device store from `@epicenter/app`.
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

	test('callback and ancestor layouts never open the device or mount the app', async () => {
		for (const file of [callback, ...ancestorLayouts(callback)]) {
			const text = await Bun.file(file).text();
			expect(text).not.toMatch(/openDevice\s*\(|openRemote\s*\(/);
			expect(text).not.toMatch(/@epicenter\/folder/);
			expect(text).not.toContain('VocabApp.svelte');
		}
	});
});

describe('the working page needs no account', () => {
	test('the page opens this browser’s files and mounts the app signed out, with no sign-in gate', async () => {
		const page = await Bun.file(join(routes, '+page.svelte')).text();
		expect(page).toMatch(/openDevice\(vocab\)/);
		expect(page).toMatch(
			/\{#if auth\.state\.status === 'signed-out'\}\s*<VocabApp\b/,
		);
		expect(page).not.toMatch(/AppBoot|SignInScreen|openRemote/);
	});

	test('the contract declares no account', async () => {
		const contract = await Bun.file(join(source, 'lib/contract.ts')).text();
		expect(contract).not.toMatch(/accountKey|@epicenter\/auth/);
	});

	test('no shipped source opens a store: the contract’s notes are the only saved data', async () => {
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
