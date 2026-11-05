/**
 * Vocab acquisition boundary tests.
 * `src/lib/app.ts` is the one place that opens the store: one folder for
 * the page's life (`openFolder`), the learner's repository on the web and
 * the data folder on the desktop. The `(app)` layout renders the pages over
 * it, or the sign-in while the web build is signed out; the callback page
 * and its ancestor layouts mount no app; and no source opens a store of its
 * own. Which leaves each build carries is `platform.test.ts`'s.
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

/** Every shipped source file: no tests, test support or test fixtures. */
async function shippedSources(): Promise<{ path: string; text: string }[]> {
	const names = await readdir(source, { recursive: true });
	const files = names.filter(
		(name) =>
			/\.(ts|svelte)$/.test(name) &&
			!/\.(test|test-support)\.ts$/.test(name) &&
			!name.includes('fixtures/'),
	);
	return Promise.all(
		files.map(async (name) => ({
			path: relative(source, join(source, name)),
			text: await Bun.file(join(source, name)).text(),
		})),
	);
}

describe('the callback mounts no app', () => {
	test('the callback page exists and has at least one ancestor layout', () => {
		expect(existsSync(callback)).toBe(true);
		expect(ancestorLayouts(callback).length).toBeGreaterThan(0);
	});

	test('callback and ancestor layouts never open a store of their own or mount the app', async () => {
		for (const file of [callback, ...ancestorLayouts(callback)]) {
			const text = await Bun.file(file).text();
			expect(text).not.toMatch(/@epicenter\/folder/);
			expect(text).not.toMatch(/VocabApp\.svelte|WhenOpen/);
		}
	});
});

describe('app.ts opens the one store', () => {
	test('one folder for the page, over the account connectAccount() answers', async () => {
		const app = await Bun.file(join(source, 'lib/app.ts')).text();
		expect(app).toMatch(/const signIn = connectAccount\(\{/);
		expect(app).toMatch(
			/export const folder = reactive\(\s*openFolder\(vocab, home\(\{ site: APPS\.VOCAB\.url, account: signIn \}\)\),\s*\);/,
		);
		expect(app).not.toMatch(/\bawait\b|import\.meta\.hot/);
	});

	test('the layout asks for a sign-in where the account is required and signed out, and otherwise renders the pages over the folder', async () => {
		const layout = await Bun.file(join(routes, '(app)/+layout.svelte')).text();
		expect(layout).toMatch(
			/\{#if accountPurpose\.required && account\.state\(\)\.status === 'signed-out'\}\s*<SignIn \/>\s*\{:else\}\s*<WhenOpen app="Vocab" \{folder\} \{settings\}>\{@render children\(\)\}<\/WhenOpen>/,
		);
		const page = await Bun.file(join(routes, '(app)/+page.svelte')).text();
		expect(page).toMatch(/<VocabApp \/>/);
	});

	test('the contract declares no account', async () => {
		const contract = await Bun.file(join(source, 'lib/contract.ts')).text();
		expect(contract).not.toMatch(/accountKey|@epicenter\/auth/);
	});

	test('no source opens a store of its own: app.ts’s folder is the only one', async () => {
		const openers = (await shippedSources())
			.filter(({ text }) =>
				/@epicenter\/app\/(open|store|memory)|@epicenter\/folder\/(browser|remote|tauri|memory|node)|\bopenDevice\b|\bopenRemote\b|\bopenDataFolder\b|\bfolderOf\b|desktop-startup|\bopenLocal\b|\bopenPersonal\b|PersistenceNotice|fromData\b/.test(
					text,
				),
			)
			.map(({ path }) => path);
		expect(openers).toEqual([]);
	});
});
