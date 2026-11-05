/**
 * What the page may import, and who opens what.
 *
 * The page runs in a browser tab or in the desktop window, so nothing under
 * `src/` may reach Node or Bun, and only the desktop leaves (`*.tauri.ts`,
 * `*.tauri.svelte.ts`, `components/Desktop*.svelte`) reach Tauri. Its files
 * are Whispering's contract's folder (decision 10), opened once, in
 * `src/lib/app.ts`, with every other capability, and never over the
 * account: nothing opens or reads a repository, and nothing uploads
 * (ADR-0700).
 * Nothing in the app, its tests included, uses the retired folder and table
 * API. The build chooses every variant's piece through `#platform/*`, so no
 * shared code asks where it is running. This reads the sources, so a violation
 * names its file.
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

/** A module only the desktop build reaches: a `tauri` leaf, or what only those leaves import. */
const desktopOnly = (path: string) =>
	/\.tauri(\.svelte)?\.ts$/.test(path) ||
	/^lib\/components\/Desktop\w*\.svelte$/.test(path);

function importers(matches: (specifier: string) => boolean) {
	const found: string[] = [];
	for (const file of files)
		for (const [, specifier] of file.text.matchAll(IMPORT))
			if (specifier !== undefined && matches(specifier))
				found.push(`${file.path} imports ${specifier}`);
	return found;
}

test('the page imports no Node, Bun, or Tauri module', () => {
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
				// The bare entry is picked by the build (null on the web);
				// its subpaths are the desktop's alone.
				specifier.startsWith('@epicenter/transcription/'),
		).filter((source) => !desktopOnly(source.split(' imports ')[0]!)),
	).toEqual([]);
	// A desktop module is reached only from another, or through a seam.
	expect(
		importers((specifier) =>
			/\.tauri(\.svelte)?(\.js)?$|\/Desktop\w*\.svelte$/.test(specifier),
		).filter((source) => !desktopOnly(source.split(' imports ')[0]!)),
	).toEqual([]);
});

test('the store is opened once, in app.ts, never over the account; nothing opens a repository', () => {
	expect(callers('openFolder')).toEqual(['lib/app.ts']);
	expect(callers('home')).toEqual(['lib/app.ts']);
	// The build picks the store: this browser's on the web, the data folder
	// on the desktop. Given an account, the web would open its repository.
	expect(files.find((file) => file.path === 'lib/app.ts')?.text).toContain(
		'openFolder(whispering, home({ site: APPS.WHISPERING.url }))',
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

test('a microphone is reached only through its build’s recorder entry', () => {
	// Each build's `#platform/computer` leaf names its recorder, and `app.ts`
	// makes the one microphone device over the folder with it. Shared code
	// names the bare specifier, which is the recording contract alone.
	expect(
		importers((specifier) => specifier === '@epicenter/recorder/tauri'),
	).toEqual([
		'lib/platform/computer.tauri.ts imports @epicenter/recorder/tauri',
	]);
	expect(
		importers((specifier) => specifier === '@epicenter/recorder/browser'),
	).toEqual(['lib/platform/computer.ts imports @epicenter/recorder/browser']);
	expect(callers('createMicrophoneDevice')).toEqual(['lib/app.ts']);
});

test('the capabilities are made once, in app.ts, from the build’s leaves', () => {
	for (const seam of ['#platform/account', '#platform/computer'])
		expect(importers((specifier) => specifier === seam)).toEqual([
			`lib/app.ts imports ${seam}`,
		]);
	for (const name of [
		'connectAccount',
		'openAi',
		'modelChoices',
		'localSpeech',
	])
		expect(callers(name)).toEqual(['lib/app.ts']);
});

/** What only the desktop's leaves use of `@epicenter/svelte`: the data folder's sync and onboarding. */
const DESKTOP_SVELTE = [
	'@epicenter/svelte/folder-onboarding',
	'@epicenter/svelte/folder-sync',
	'@epicenter/svelte/folder-sync-actions',
];

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
			return !(desktopOnly(file!) && DESKTOP_SVELTE.includes(specifier!));
		}),
	).toEqual([]);
});

test('the platform leaves own auth composition; nothing else names the account', () => {
	expect(
		importers((specifier) => specifier.startsWith('@epicenter/account')).filter(
			(source) =>
				!source.startsWith('lib/platform/') &&
				!source.startsWith('lib/components/SignInCallback.svelte '),
		),
	).toEqual([]);
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
	// The root renders the app only over the open folder, with no account
	// asked for: signing in grants capabilities, never storage.
	const layout = files.find(
		(file) => file.path === 'routes/(app)/+layout.svelte',
	)?.text;
	expect(layout).toContain('<WhenOpen app="Whispering" {folder} {settings}>');
	expect(layout).toContain('<WhisperingApp>');
	expect(layout).not.toMatch(/import \{[^}]*\baccount\b/);
	expect(layout).not.toContain('SignIn');
	for (const callback of [
		'routes/auth/callback/+page.svelte',
		'lib/components/SignInCallback.svelte',
		'lib/components/DesktopCallback.svelte',
	])
		expect(files.find((file) => file.path === callback)?.text).not.toMatch(
			/getWhispering\(\)|getLibrary\(\)|device/,
		);
});
