/**
 * What the page may import, and who opens what.
 *
 * The page runs in a browser tab or in the desktop window, so nothing under
 * `src/` may reach Node or Bun, and only the desktop leaves (`*.tauri.ts`,
 * `*.tauri.svelte.ts`, `components/Desktop*.svelte`) reach Tauri. Its files
 * are Whispering's contract's client (decision 10), opened in one place per
 * variant, the variant's `Startup` (`#platform/root`), which hands it to the
 * app; nothing opens or reads a repository, and nothing uploads (ADR-0700).
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
				specifier.startsWith('@epicenter/transcription-native'),
		).filter((source) => !desktopOnly(source.split(' imports ')[0]!)),
	).toEqual([]);
	// A desktop module is reached only from another, or through a seam.
	expect(
		importers((specifier) =>
			/\.tauri(\.svelte)?(\.js)?$|\/Desktop\w*\.svelte$/.test(specifier),
		).filter((source) => !desktopOnly(source.split(' imports ')[0]!)),
	).toEqual([]);
});

test('the store is opened once, by each variant’s startup; nothing opens a repository', () => {
	expect(callers('openDevice')).toEqual(['lib/components/LocalStartup.svelte']);
	expect(callers('openDataFolder')).toEqual([
		'lib/components/DesktopStartup.svelte',
	]);
	expect(
		importers((specifier) => specifier === '@epicenter/folder/browser'),
	).toEqual([
		'lib/components/LocalStartup.svelte imports @epicenter/folder/browser',
	]);
	for (const name of ['openRemote', 'setRepo', 'getRepo'])
		expect(callers(name)).toEqual([]);
	expect(
		importers(
			(specifier) =>
				specifier === '@epicenter/folder/remote' ||
				specifier === '@epicenter/svelte/repo',
		),
	).toEqual([]);
});

test('nothing in the app uses the retired folder and table API', () => {
	const retired =
		/\b(openFolder|svelteFolder|defineTable|prepareDefinition)\b|@epicenter\/svelte\/(folder|open-folder|row-issues)['"]|from ['"]@epicenter\/(folder|definition)['"]/;
	expect(
		[...everything(src)]
			// This file names the retired API to look for it.
			.filter((path) => path !== fileURLToPath(import.meta.url))
			.filter((path) => retired.test(readFileSync(path, 'utf8')))
			.map((path) => relative(src, path)),
	).toEqual([]);
});

test('a microphone is reached only through its build’s recorder entry', () => {
	// The WebView microphone reaches the browser's recorder, the shell's
	// microphone the desktop's. Shared code names the bare specifier, which
	// is the recording contract alone.
	expect(
		importers((specifier) => specifier === '@epicenter/recorder/tauri'),
	).toEqual([
		'lib/platform/microphone.tauri.ts imports @epicenter/recorder/tauri',
	]);
	expect(callers('createShellMicrophone')).toEqual([
		'lib/platform/services.tauri.ts',
	]);
	expect(
		importers((specifier) => specifier === '@epicenter/recorder/browser'),
	).toEqual(['lib/webview-microphone.ts imports @epicenter/recorder/browser']);
	expect(callers('createWebViewMicrophone')).toEqual([
		'lib/platform/browser.ts',
	]);
});

test('the services are reached through the seam alone', () => {
	expect(
		files.filter((file) =>
			/(?:from\s+|import\s*\(\s*)['"][^'"]*platform\/browser\.js['"]|(?:from\s+|import\s*\(\s*)['"]\.\/browser\.js['"]/.test(
				file.text,
			),
		),
	).toEqual([]);
	expect(importers((specifier) => specifier === '#platform/services')).toEqual([
		'lib/whispering.svelte.ts imports #platform/services',
	]);
});

/** What only the desktop's leaves use of `@epicenter/svelte`: the data folder's sync and recovery screen. */
const DESKTOP_SVELTE = [
	'@epicenter/svelte/folder-sync',
	'@epicenter/svelte/folder-sync-actions',
	'@epicenter/svelte/recovery',
];

test('the page imports no Yjs store, sync, history, or store module', () => {
	expect(
		importers(
			(specifier) =>
				specifier === 'yjs' ||
				specifier.startsWith('@y/') ||
				specifier.startsWith('@epicenter/sync') ||
				// Notes are read and edited through the contract's client as
				// Svelte state; the other shared pieces are the leave guard, the
				// header status and an edit's unsaved notice.
				(specifier.startsWith('@epicenter/svelte') &&
					![
						'@epicenter/svelte/client',
						'@epicenter/svelte/leave-guard',
						'@epicenter/svelte/note-repair',
						'@epicenter/svelte/status-line',
						'@epicenter/svelte/status-popover',
						'@epicenter/svelte/status-row',
						'@epicenter/svelte/unsaved-edit',
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
		importers((specifier) => specifier.startsWith('@epicenter/auth')).filter(
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

test('WhisperingApp composes Whispering over the client it is given', () => {
	for (const name of [
		'createWhispering',
		'setWhispering',
		'filesOf',
		'createLibrary',
		'setLibrary',
	])
		expect(callers(name)).toEqual(['routes/components/WhisperingApp.svelte']);
	expect(callers('createServices')).toEqual(['lib/whispering.svelte.ts']);
	// The desktop root also wraps its two roots once, for the shortcut's notes.
	expect(callers('fromClient')).toEqual([
		'lib/components/DesktopRoot.svelte',
		'lib/files.svelte.ts',
	]);
	expect(
		files.find((file) => file.path === 'routes/components/WhisperingApp.svelte')
			?.text,
	).toContain('client: Client<WhisperingContract>');
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
	// The variant's Startup opens the store and hands its client to the app.
	const layout = files.find(
		(file) => file.path === 'routes/(app)/+layout.svelte',
	)?.text;
	expect(layout).toContain("import { Startup } from '#platform/root';");
	expect(layout).toContain('<WhisperingApp {client}>');
	for (const startup of ['LocalStartup', 'DesktopStartup'])
		expect(
			files.find((file) => file.path === `lib/components/${startup}.svelte`)
				?.text,
		).toMatch(/\{@render children\(device\.data\)\}/);
	for (const callback of [
		'routes/auth/callback/+page.svelte',
		'lib/components/SignInCallback.svelte',
		'lib/components/DesktopCallback.svelte',
	])
		expect(files.find((file) => file.path === callback)?.text).not.toMatch(
			/getWhispering\(\)|getLibrary\(\)|device/,
		);
});
