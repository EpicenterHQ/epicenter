/**
 * What the page may import, and who opens what.
 *
 * One build runs in a browser tab and in a Tauri window (ADR-0781), so
 * nothing under `src/` may reach Node or Bun. The page reaches Tauri in a
 * few named places, each of which asks `isTauri()` or runs only on the
 * desktop, and loads every Tauri module but `@tauri-apps/api/core` when it
 * is first used, so a browser never loads one. Whispering's files are one
 * `Files` (ADR-0894), chosen and opened once in `src/lib/app.ts` with every
 * other capability. This reads the sources, so a violation names its file.
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

function importers(matches: (specifier: string) => boolean) {
	const found: string[] = [];
	for (const file of files)
		for (const [, specifier] of file.text.matchAll(IMPORT))
			if (specifier !== undefined && matches(specifier))
				found.push(`${file.path} imports ${specifier}`);
	return found;
}

/** Where the page reaches Tauri: the composition, this computer's secrets and requests, the shortcut, the one-tab lock, the desktop's files, and the folder's settings. */
const TAURI = [
	'lib/app.ts',
	'lib/components/FolderSettings.svelte',
	'lib/files/tauri.ts',
	'lib/one-tab.svelte.ts',
	'lib/shortcut.ts',
	'lib/this-computer.ts',
];

test('the page imports no Node or Bun module, and reaches Tauri only in its named places', () => {
	expect(
		importers(
			(specifier) =>
				specifier.startsWith('node:') || specifier.startsWith('bun'),
		),
	).toEqual([]);
	const tauri = importers((specifier) => specifier.startsWith('@tauri-apps/'));
	expect([
		...new Set(tauri.map((found) => found.split(' imports ')[0])),
	]).toEqual(TAURI);
	// Only `@tauri-apps/api/core` loads with the page; the rest load when used.
	for (const file of files)
		expect(
			[...file.text.matchAll(/^import [^;]*'(@tauri-apps\/[^']+)'/gm)]
				.map(([, specifier]) => `${file.path} imports ${specifier}`)
				.filter((found) => !found.endsWith('@tauri-apps/api/core')),
		).toEqual([]);
	expect(callers('isTauri')).toEqual([
		'lib/app.ts',
		'lib/one-tab.svelte.ts',
		'lib/shortcut.ts',
		'lib/this-computer.ts',
	]);
});

test('the files are chosen and opened once, in app.ts', () => {
	for (const name of ['openFolder', 'tauriFiles', 'opfsFiles'])
		expect(callers(name)).toEqual(['lib/app.ts']);
	// Memory is a test's files.
	expect(callers('memoryFiles')).toEqual([]);
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
		'openAi',
		'customEndpoints',
		'localServers',
		'localSpeech',
		'openShortcut',
	])
		expect(callers(name)).toEqual(['lib/app.ts']);
});

test('the page imports no Yjs store, sync, account, or shared folder package, and from @epicenter/app only its Markdown grammar', () => {
	expect(
		importers(
			(specifier) =>
				specifier === 'yjs' ||
				specifier.startsWith('@y/') ||
				specifier.startsWith('@epicenter/sync') ||
				specifier.startsWith('@epicenter/account') ||
				specifier.startsWith('@epicenter/svelte') ||
				specifier.startsWith('@epicenter/folder') ||
				specifier.startsWith('@epicenter/local') ||
				specifier === '@epicenter/app' ||
				(specifier.startsWith('@epicenter/app/') &&
					specifier !== '@epicenter/app/markdown'),
		),
	).toEqual([]);
});

/** `text` without its comment lines (` * ...` and `// ...`), which name calls they do not make. */
const withoutComments = (text: string) =>
	text.replace(/^\s*(\*|\/\/).*$/gm, '');

/** Files whose source calls `name(` (or `name<T>(`), ignoring its own declaration. */
function callers(name: string) {
	const call = new RegExp(`(?<!function )\\b${name}(<[^>()]*>)?\\(`);
	return files
		.filter((file) => call.test(withoutComments(file.text)))
		.map((file) => file.path);
}

test('WhisperingApp composes Whispering over the capabilities app.ts opened', () => {
	for (const name of [
		'createWhispering',
		'setWhispering',
		'createLibrary',
		'setLibrary',
	])
		expect(callers(name)).toEqual(['routes/components/WhisperingApp.svelte']);
	expect(
		files.find((file) => file.path === 'routes/components/WhisperingApp.svelte')
			?.text,
	).toContain("import { ai, folder, recorder } from '$lib/app.js';");
});

test('the app group has every page, and every page reads its library from context', () => {
	const pages = files.filter((file) => /\+page\.svelte$/.test(file.path));
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
	// The root renders the app once the folder was read, in the one tab that holds it.
	const layout = files.find(
		(file) => file.path === 'routes/(app)/+layout.svelte',
	)?.text;
	expect(layout).toContain('holdOneTab()');
	expect(layout).toContain('await folder.load()');
	expect(layout).toContain('<WhisperingApp>');
});
