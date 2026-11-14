/**
 * What the page may import, and who opens what.
 *
 * One build runs in a browser tab and in a Tauri window (ADR-0781), so
 * nothing under `src/` may reach Node or Bun, and the page reaches Tauri
 * only through its capabilities: the packages choose where the page runs,
 * and the one app-owned capability that does, the global shortcut
 * (`lib/shortcut.ts`), loads the shell's event code when it listens. Its
 * files are Whispering's contract's folder (decision 10), opened once, in
 * `src/lib/app.ts`, with every other capability, over the account in a
 * browser (ADR-0786). Nothing in the app, its tests included, uses the
 * retired folder and table API, and no app code asks where it is running.
 * This reads the sources, so a violation names its file.
 */
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('..', import.meta.url));

/** Every page source under `directory`, in name order on every filesystem. */
function* sources(directory: string): Generator<string> {
	for (const name of readdirSync(directory).sort()) {
		const path = join(directory, name);
		if (statSync(path).isDirectory()) yield* sources(path);
		else if (
			/\.(ts|svelte)$/.test(name) &&
			!/\.test(-support)?\.ts$/.test(name)
		)
			yield path;
	}
}

const IMPORT = /(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;

const files = [...sources(src)].map((path) => ({
	path: relative(src, path),
	text: readFileSync(path, 'utf8'),
}));

/** Every source under `src/`, tests and their support included. */
function* everything(directory: string): Generator<string> {
	for (const name of readdirSync(directory).sort()) {
		const path = join(directory, name);
		if (statSync(path).isDirectory()) yield* everything(path);
		else if (/\.(ts|svelte)$/.test(name)) yield path;
	}
}

/** The views of a folder on this computer, which use the shell's folder sync. */
const folderViews = (path: string) =>
	/^lib\/components\/Folder\w*\.svelte$/.test(path);

function importers(matches: (specifier: string) => boolean) {
	const found: string[] = [];
	for (const file of files)
		for (const [, specifier] of file.text.matchAll(IMPORT))
			if (specifier !== undefined && matches(specifier))
				found.push(`${file.path} imports ${specifier}`);
	return found;
}

test('the page imports no Node or Bun module, and reaches Tauri only through a capability', () => {
	expect(
		importers(
			(specifier) =>
				specifier.startsWith('node:') ||
				specifier.startsWith('bun') ||
				// The directory opener runs in Bun, never in a page.
				/^@epicenter\/folder(\/next)?\/bun$/.test(specifier),
		),
	).toEqual([]);
	expect(
		importers(
			(specifier) =>
				specifier.startsWith('@tauri-apps/') ||
				specifier.endsWith('/tauri') ||
				specifier.endsWith('/browser'),
		),
	).toEqual([
		'lib/shortcut.ts imports @tauri-apps/api/core',
		'lib/shortcut.ts imports @tauri-apps/api/event',
	]);
	// The shell's event code loads when the shortcut listens, never with the page.
	expect(
		files.find((file) => file.path === 'lib/shortcut.ts')?.text,
	).not.toMatch(/^import .*'@tauri-apps\/api\/event'/m);
	// No app code asks where it is running; a capability does.
	expect(
		callers('isTauri').filter((path) => path !== 'lib/shortcut.ts'),
	).toEqual([]);
});

test('the store is opened once, in app.ts, never over the account; nothing opens a repository', () => {
	expect(callers('openFolder')).toEqual(['lib/app.ts']);
	expect(callers('home')).toEqual(['lib/app.ts']);
	// The package picks the store: the account's repository in a browser,
	// the data folder in a Tauri window.
	expect(files.find((file) => file.path === 'lib/app.ts')?.text).toContain(
		'home({ site: APPS.WHISPERING.url, account: signIn })',
	);
	for (const name of [
		'createFolder',
		'openDevice',
		'openDataFolder',
		'openAppData',
		'openRemote',
		'folderOf',
		'directory',
		'memory',
	])
		expect(callers(name)).toEqual([]);
	// A page opens its folder at its home alone: a directory is a script's
	// or a test's place, and memory a test's.
	expect(
		importers(
			(specifier) =>
				specifier === '@epicenter/folder/node' ||
				specifier === '@epicenter/folder/memory' ||
				specifier === '@epicenter/svelte/desktop-startup',
		),
	).toEqual([]);
});

test('a microphone is reached only through the recorder package, in app.ts', () => {
	// `@epicenter/recorder` chooses the shell's or the page's microphone, and
	// `app.ts` makes the one microphone device over the folder with it.
	expect(callers('createMicrophoneDevice')).toEqual(['lib/app.ts']);
	expect(
		files
			.filter((file) =>
				/import \{[^}]*\brecorder\b[^}]*\} from '@epicenter\/recorder'/.test(
					file.text,
				),
			)
			.map((file) => file.path),
	).toEqual(['lib/app.ts']);
});

test('the capabilities are made once, in app.ts', () => {
	for (const name of [
		'connectAccount',
		'openAi',
		'modelChoices',
		'localSpeech',
		'openShortcut',
		'customEndpoints',
	])
		expect(callers(name)).toEqual(['lib/app.ts']);
});

/** What only the views of a folder on this computer use of `@epicenter/svelte`: its onboarding. */
const FOLDER_SVELTE = ['@epicenter/svelte/folder-onboarding'];

test('the page imports no Yjs store, sync, history, or store module', () => {
	expect(
		importers(
			(specifier) =>
				specifier === 'yjs' ||
				specifier.startsWith('@y/') ||
				specifier.startsWith('@epicenter/sync') ||
				// Notes are read and edited through the contract's client as a
				// folder, which `reactive` reads as Svelte state; the other shared
				// pieces are the root over the folder, the header status and a
				// note's repair.
				(specifier.startsWith('@epicenter/svelte') &&
					![
						'@epicenter/svelte/note-repair',
						'@epicenter/svelte/reactive',
						'@epicenter/svelte/status-line',
						'@epicenter/svelte/status-popover',
						'@epicenter/svelte/status-row',
						'@epicenter/svelte/when-open',
					].includes(specifier)) ||
				// The store package, by any entry. Files come through the
				// contract's client.
				specifier === '@epicenter/app' ||
				specifier.startsWith('@epicenter/app/'),
		).filter((source) => {
			const [file, specifier] = source.split(' imports ');
			return !(folderViews(file!) && FOLDER_SVELTE.includes(specifier!));
		}),
	).toEqual([]);
});

test('app.ts composes the account; only the sign-in callback names it besides', () => {
	expect(
		importers((specifier) => specifier.startsWith('@epicenter/account')),
	).toEqual([
		'lib/app.ts imports @epicenter/account',
		'lib/components/SignInCallback.svelte imports @epicenter/account',
	]);
});

/** Files whose source calls `name(` (or `name<T>(`), ignoring its own declaration. */
function callers(name: string) {
	const call = new RegExp(`(?<!function )\\b${name}(<[^>()]*>)?\\(`);
	return files.filter((file) => call.test(file.text)).map((file) => file.path);
}

test('WhisperingApp composes Whispering over the capabilities app.ts opened', () => {
	for (const name of [
		'createWhispering',
		'setWhispering',
		'filesOf',
		'createLibrary',
		'setLibrary',
	])
		expect(callers(name)).toEqual(['routes/components/WhisperingApp.svelte']);
	expect(
		files.find((file) => file.path === 'routes/components/WhisperingApp.svelte')
			?.text,
	).toContain("import { ai, choices, folder, recorder } from '$lib/app.js';");
});

test('the app group has every page, and every page reads its library from context', () => {
	const pages = files.filter(
		(file) =>
			/\+page\.svelte$/.test(file.path) &&
			file.path !== 'routes/auth/callback/+page.svelte',
	);
	expect(pages.map((file) => file.path).sort()).toEqual([
		'routes/(app)/+page.svelte',
		'routes/(app)/recordings/+page.svelte',
		'routes/(app)/transformations/+page.svelte',
	]);
	const bodies = {
		'+page.svelte': 'HomePage',
		'recordings/+page.svelte': 'RecordingsPage',
		'transformations/+page.svelte': 'TransformationsPage',
	} as const;
	for (const [page, body] of Object.entries(bodies)) {
		expect(
			files.find((file) => file.path === `routes/(app)/${page}`)?.text,
		).toContain(`<${body} />`);
		expect(
			files.find((file) => file.path === `routes/components/${body}.svelte`)
				?.text,
		).toContain('getLibrary()');
	}
	// The root renders the app only over the open folder; where the folder
	// is the person's repository, a signed-out page asks to sign in first.
	const layout = files.find(
		(file) => file.path === 'routes/(app)/+layout.svelte',
	)?.text;
	expect(layout).toContain('<WhenOpen app="Whispering" {folder} {settings}>');
	expect(layout).toContain('<WhisperingApp>');
	expect(layout).toContain(
		"{#if folder.reveal === null && account.state().status === 'signed-out'}",
	);
	for (const callback of [
		'routes/auth/callback/+page.svelte',
		'lib/components/SignInCallback.svelte',
	])
		expect(files.find((file) => file.path === callback)?.text).not.toMatch(
			/getWhispering\(\)|getLibrary\(\)|device/,
		);
});
