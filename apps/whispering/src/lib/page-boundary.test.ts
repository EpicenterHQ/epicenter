/**
 * What the page may import, and who opens what.
 *
 * The page runs in a browser tab, so nothing under `src/` may reach Node,
 * Bun or Tauri. Its files are Whispering's contract's client (decision 10):
 * this browser's device is opened in one place, at the root, and the
 * repository and its uploader in one place, the signed-in subtree. Nothing
 * in the app, its tests included, uses the retired folder and table API.
 * The services come through `#platform/services`, so no page code asks where
 * it is running. This reads the sources, so a violation names its file.
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

test('the device is opened once, in its module, and the repository at the signed-in boundary', () => {
	expect(callers('openDevice')).toEqual(['lib/device.ts']);
	expect(callers('setRepo')).toEqual(['routes/components/SignedIn.svelte']);
	expect(callers('openRemote')).toEqual(['routes/components/SignedIn.svelte']);
	expect(callers('startUploading')).toEqual([
		'routes/components/SignedIn.svelte',
	]);
	expect(
		importers((specifier) => specifier === '@epicenter/folder/remote'),
	).toEqual([
		'routes/components/SignedIn.svelte imports @epicenter/folder/remote',
	]);
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

test('a microphone is reached only through the browser recorder entry', () => {
	// Only the WebView microphone reaches the browser's recorder. Shared code
	// names the bare specifier, which is the recording contract alone.
	expect(
		importers((specifier) => specifier === '@epicenter/recorder/tauri'),
	).toEqual([]);
	expect(
		importers((specifier) => specifier === '@epicenter/recorder/browser'),
	).toEqual([
		'lib/microphone.ts imports @epicenter/recorder/browser',
		'lib/webview-microphone.ts imports @epicenter/recorder/browser',
	]);
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
				// Notes are read and edited through the contract's client as
				// Svelte state; the other shared pieces are the leave guard, the
				// header status and an edit's unsaved notice.
				(specifier.startsWith('@epicenter/svelte') &&
					![
						'@epicenter/svelte/client',
						'@epicenter/svelte/leave-guard',
						'@epicenter/svelte/note-repair',
						'@epicenter/svelte/repo',
						'@epicenter/svelte/status-line',
						'@epicenter/svelte/status-popover',
						'@epicenter/svelte/status-row',
						'@epicenter/svelte/unsaved-edit',
					].includes(specifier)) ||
				// The store package, by any entry. Files come through the
				// contract's client.
				specifier === '@epicenter/app' ||
				specifier.startsWith('@epicenter/app/'),
		),
	).toEqual([]);
});

test('the platform leaf owns auth composition; the subtree only names the account', () => {
	expect(
		importers((specifier) => specifier.startsWith('@epicenter/auth')).filter(
			(source) =>
				!source.startsWith('lib/platform/') &&
				!source.startsWith('routes/auth/callback/'),
		),
	).toEqual(['routes/components/SignedIn.svelte imports @epicenter/auth']);
	expect(
		files.find((file) => file.path === 'routes/components/SignedIn.svelte')
			?.text,
	).toContain("import type { Account } from '@epicenter/auth'");
});

/** Files whose source calls `name(`, ignoring its own declaration. */
function callers(name: string) {
	const call = new RegExp(`(?<!function )\\b${name}\\(`);
	return files.filter((file) => call.test(file.text)).map((file) => file.path);
}

test('WhisperingApp owns product state', () => {
	expect(callers('createWhispering')).toEqual([
		'routes/components/WhisperingApp.svelte',
	]);
	expect(callers('createServices')).toEqual(['lib/whispering.svelte.ts']);
	expect(callers('createAudio')).toEqual(['lib/whispering.svelte.ts']);
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
	]);
});
