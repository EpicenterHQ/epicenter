/**
 * Emitted Bundle Tests
 *
 * Builds one small application with Vite, the way an app is built, and reads
 * the chunks that come out. What a build carries is checked in the output,
 * not assumed from tree shaking.
 *
 * Key behaviors:
 * - The automatic entry puts neither adapter in the code that loads first.
 *   Both adapters are separate chunks, loaded only when a folder is opened
 * - Aliasing the exact bare specifier to `/browser` emits no desktop adapter
 *   and no IndexedDB access anywhere; aliasing it to `/tauri` loads only the
 *   desktop adapter first. The directory folder a page runs over a granted
 *   directory, with Tauri's fs plugin and the shell's Git, is a lazy chunk
 *   the desktop adapter loads only when the shell grants a folder; it holds
 *   none of the browser folder's storage address or private Git. The
 *   application source is the same file
 * - Importing an explicit entry directly gives the same output as the alias
 * - The desktop adapter's first chunk never includes isomorphic-git
 * - No build carries a shell
 *
 * The alias here is the one the package documents, and the specifiers are
 * resolved through the package's own `exports`.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { build, type Rollup } from 'vite';

const APP = join(import.meta.dir, 'app');

/** Text only the desktop adapter contains: the plugin's command names. */
const DESKTOP = 'plugin:epicenter-folder|attach';
/** Text only the browser adapter contains: its lock names. */
const BROWSER = 'epicenter-folder:${id}:git';
/** Text only isomorphic-git contains: its Git protocol client. */
const GIT = 'git-upload-pack';
/** Text only the page engine over a granted directory contains. */
const GRANTED = 'epicenter-folder-directory-files:';
/** Text only Tauri's fs plugin client contains. */
const TAURI_FS = 'plugin:fs|';
/** Text only just-bash contains: a command its shell offers. No build carries it. */
const SHELL = 'sha256sum';

type Built = {
	readonly chunks: readonly Rollup.OutputChunk[];
	/** The entry chunk and everything it imports statically, as one text. */
	readonly initial: string;
	/** Every emitted chunk, as one text. */
	readonly everything: string;
	/** A chunk and everything it imports statically. */
	closure(chunk: Rollup.OutputChunk): string;
	/** Chunks reached only through `import()`, with their static closure. */
	readonly lazy: readonly string[];
};

async function bundle(
	entry: 'main' | 'browser' | 'tauri',
	root?: '@epicenter/folder/browser' | '@epicenter/folder/tauri',
): Promise<Built> {
	const result = await build({
		root: APP,
		configFile: false,
		logLevel: 'silent',
		resolve: {
			// The documented specialization: the exact bare specifier, and
			// nothing below it, resolves to one explicit entry.
			alias:
				root === undefined
					? []
					: [{ find: /^@epicenter\/folder$/, replacement: root }],
		},
		build: {
			write: false,
			minify: false,
			target: 'esnext',
			modulePreload: false,
			rollupOptions: {
				input: join(APP, `${entry}.ts`),
				preserveEntrySignatures: 'strict',
			},
		},
	});
	const output = (Array.isArray(result) ? result : [result]).flatMap((item) =>
		'output' in item ? item.output : [],
	);
	const chunks = output.filter(
		(item): item is Rollup.OutputChunk => item.type === 'chunk',
	);
	const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
	function staticClosure(start: Rollup.OutputChunk) {
		const seen = new Set<string>();
		const visit = (chunk: Rollup.OutputChunk) => {
			if (seen.has(chunk.fileName)) return;
			seen.add(chunk.fileName);
			for (const name of chunk.imports) {
				const imported = byName.get(name);
				if (imported !== undefined) visit(imported);
			}
		};
		visit(start);
		return seen;
	}
	const text = (names: Iterable<string>) =>
		[...names].map((name) => byName.get(name)?.code ?? '').join('\n');
	const entryChunk = chunks.find((chunk) => chunk.isEntry);
	if (entryChunk === undefined) throw new Error('the build emitted no entry');
	const initialNames = staticClosure(entryChunk);
	return {
		chunks,
		initial: text(initialNames),
		everything: text(byName.keys()),
		closure: (chunk) => text(staticClosure(chunk)),
		lazy: chunks
			.filter((chunk) => chunk.isDynamicEntry)
			.map((chunk) => text(staticClosure(chunk))),
	};
}

describe('what a Vite build of the same application emits', () => {
	test('automatic entry: both adapters are emitted, each lazy, and neither loads with the page', async () => {
		const built = await bundle('main');

		// The code that loads first holds the contract and the choice, only.
		expect(built.initial).toContain('so.epicenter.bundlefixture');
		expect(built.initial).not.toContain(DESKTOP);
		expect(built.initial).not.toContain(BROWSER);
		expect(built.initial).not.toContain(GIT);
		expect(built.everything).not.toContain(SHELL);

		// One artifact carries both adapters, each behind its own `import()`.
		// The desktop adapter loads the page engine for a granted folder
		// behind another `import()`; that chunk reuses the adapter's commands.
		const desktopLazy = built.lazy.filter((code) => code.includes(DESKTOP));
		const desktop = desktopLazy.filter((code) => !code.includes(GRANTED));
		const granted = desktopLazy.filter((code) => code.includes(GRANTED));
		const browser = built.lazy.filter((code) => code.includes(BROWSER));
		expect(desktop).toHaveLength(1);
		expect(granted).toHaveLength(1);
		expect(browser).toHaveLength(1);
		// The page engine over a granted directory is the directory folder:
		// Tauri's fs plugin and the shell's Git, and none of the browser's own
		// storage address, download, or private Git.
		expect(granted[0]).toContain(TAURI_FS);
		expect(granted[0]).toContain('plugin:epicenter-folder|run_git');
		expect(granted[0]).not.toContain(BROWSER);
		// Loading the desktop adapter loads no Git and no browser storage.
		expect(desktop[0]).not.toContain(GIT);
		expect(desktop[0]).not.toContain(BROWSER);
		// Loading the browser adapter loads no desktop commands.
		expect(browser[0]).toContain(GIT);
		expect(browser[0]).not.toContain(DESKTOP);
	}, 120_000);

	test('exact alias to the browser entry: no desktop adapter is emitted at all', async () => {
		const built = await bundle('main', '@epicenter/folder/browser');
		expect(built.everything).toContain('so.epicenter.bundlefixture');
		expect(built.everything).toContain(BROWSER);
		expect(built.everything).toContain(GIT);
		expect(built.everything).not.toContain(DESKTOP);
		expect(built.everything).not.toContain('plugin:epicenter-folder|');
		// Browser folders are OPFS only: nothing emitted reaches IndexedDB.
		expect(built.everything).not.toContain('indexedDB');
		expect(built.everything).not.toContain('IDBKeyRange');
		// With one adapter there is nothing to choose, so it loads with the page.
		expect(built.initial).toContain(BROWSER);
		expect(built.everything).not.toContain(SHELL);
	}, 120_000);

	test('exact alias to the desktop entry: the desktop adapter first, and the page engine only for a granted folder', async () => {
		const built = await bundle('main', '@epicenter/folder/tauri');
		expect(built.everything).toContain('so.epicenter.bundlefixture');
		expect(built.everything).toContain(DESKTOP);
		expect(built.everything).not.toContain('indexedDB');
		expect(built.everything).not.toContain('IDBKeyRange');
		expect(built.initial).toContain(DESKTOP);
		for (const engine of [GRANTED, TAURI_FS]) {
			expect(built.initial).not.toContain(engine);
			expect(built.lazy.some((code) => code.includes(engine))).toBe(true);
		}
		// The directory folder records history with real Git; the browser's
		// isomorphic-git transport and storage address never load.
		expect(built.everything).not.toContain(BROWSER);
		expect(built.initial).not.toContain(GIT);
		expect(built.everything).not.toContain(SHELL);
	}, 120_000);

	test('importing an explicit entry gives what the alias gives', async () => {
		const browser = await bundle('browser');
		expect(browser.everything).toContain(BROWSER);
		expect(browser.everything).not.toContain(DESKTOP);

		const desktop = await bundle('tauri');
		expect(desktop.everything).toContain(DESKTOP);
		expect(desktop.initial).not.toContain(BROWSER);
		expect(desktop.initial).not.toContain(GIT);
		expect(desktop.lazy.some((code) => code.includes(GRANTED))).toBe(true);
	}, 120_000);

	test('the alias matches the bare specifier only: a subpath import is not rewritten', async () => {
		// The application names `/tauri` itself while the root is aliased to
		// `/browser`. Its import still resolves to the desktop entry.
		const built = await bundle('tauri', '@epicenter/folder/browser');
		expect(built.everything).toContain(DESKTOP);
		expect(built.initial).not.toContain(BROWSER);
	}, 120_000);
});
