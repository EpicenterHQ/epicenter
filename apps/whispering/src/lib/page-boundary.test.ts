/**
 * What the page may import.
 *
 * The page runs in a WebView and in a browser tab, so nothing under `src/` may
 * reach Node or Bun, or the directory opener that runs there. It names the
 * folder contract through `@epicenter/folder`. A folder is opened in
 * exactly one place: the layout gives OpenFolder its opener. The services
 * come through `#platform/services`, so no page code asks where it is
 * running. The recording workflow is
 * file-backed, so it may not reach the Yjs store either. This reads the
 * sources, so a violation names its file.
 *
 * The same reading establishes who owns the folder: the app layout opens one
 * folder, and pages only receive it.
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
		importers((specifier) => specifier.startsWith('@tauri-apps/')),
	).toEqual([]);
});

test('only the layout opens a folder through the build-selected entry', () => {
	// A platform entry, old or the mirror's, named directly instead of through the build.
	expect(
		importers((specifier) =>
			/^@epicenter\/folder(\/next)?\/(browser|tauri)$/.test(specifier),
		),
	).toEqual([]);
	expect(callers('openFolder')).toEqual(['routes/+layout.svelte']);
});

test('a microphone is reached only through the browser recorder entry', () => {
	// Only the WebView microphone reaches the browser's recorder. Shared code
	// names the bare specifier, which is the recording contract alone.
	expect(
		importers((specifier) => specifier === '@epicenter/recorder/tauri'),
	).toEqual([]);
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

test('the page imports no Yjs store, sync, history, or store module', () => {
	expect(
		importers(
			(specifier) =>
				specifier === 'yjs' ||
				specifier.startsWith('@y/') ||
				specifier.startsWith('@epicenter/sync') ||
				// Rows are read from the folder mirror and edited through drafts:
				// no edit owner, open-item slot, admission, or save bar. The other
				// shared views are the folder's owner and the header status.
				(specifier.startsWith('@epicenter/svelte') &&
					![
						'@epicenter/svelte/folder',
						'@epicenter/svelte/open-folder',
						'@epicenter/svelte/row-issues',
						'@epicenter/svelte/status-line',
						'@epicenter/svelte/status-popover',
						'@epicenter/svelte/status-row',
						'@epicenter/svelte/unsaved-edit',
					].includes(specifier)) ||
				// The store package, by any entry. Folders and their declarations
				// come from `@epicenter/folder` and `@epicenter/definition`.
				specifier === '@epicenter/app' ||
				specifier.startsWith('@epicenter/app/'),
		),
	).toEqual([]);
});

test('platform leaves own auth composition; the callback only checks its capability', () => {
	expect(
		importers((specifier) => specifier.startsWith('@epicenter/auth')).filter(
			(source) =>
				!source.startsWith('lib/platform/') &&
				!source.startsWith('routes/auth/callback/'),
		),
	).toEqual([]);
});

/** Files whose source calls `name(`, ignoring its own declaration. */
function callers(name: string) {
	const call = new RegExp(`(?<!function )\\b${name}\\(`);
	return files.filter((file) => call.test(file.text)).map((file) => file.path);
}

test('OpenFolder owns the folder and WhisperingApp owns product state', () => {
	expect(callers('createWhispering')).toEqual([
		'routes/components/WhisperingApp.svelte',
	]);

	expect(callers('createServices')).toEqual(['lib/whispering.svelte.ts']);
	expect(importers((s) => s === '@epicenter/svelte/open-folder')).toEqual([
		'routes/+layout.svelte imports @epicenter/svelte/open-folder',
		'routes/components/test-fixtures/WhisperingRoot.svelte imports @epicenter/svelte/open-folder',
	]);
	expect(callers('setFolder')).toEqual([
		'routes/components/WhisperingApp.svelte',
		'routes/components/test-fixtures/AudioPlaybackHost.svelte',
		'routes/components/test-fixtures/SelectionHost.svelte',
	]);
});

test('every page takes product state from context, installed by the app root', () => {
	const pages = files.filter(
		(file) =>
			/\+page\.svelte$/.test(file.path) &&
			file.path !== 'routes/auth/callback/+page.svelte',
	);
	expect(pages.map((file) => file.path).sort()).toEqual([
		'routes/+page.svelte',
		'routes/recordings/+page.svelte',
		'routes/transformations/+page.svelte',
	]);
	for (const file of pages) expect(file.text).toContain('getWhispering()');
	expect(
		files.find((file) => file.path === 'routes/auth/callback/+page.svelte')
			?.text,
	).not.toContain('getWhispering()');
	expect(callers('setWhispering')).toEqual([
		'routes/components/WhisperingApp.svelte',
		'routes/components/test-fixtures/AudioPlaybackHost.svelte',
		'routes/components/test-fixtures/SelectionHost.svelte',
	]);
});
