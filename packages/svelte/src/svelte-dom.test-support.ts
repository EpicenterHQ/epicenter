/**
 * Mounts real Svelte components over a jsdom document in Bun tests, for this
 * package and for the apps, which import it by relative path; it is test
 * support, not part of the package's exports.
 *
 * `.svelte` components and `.svelte.ts` runes modules compile for the client
 * the way the Svelte Vite plugin compiles them. A compiler warning in the
 * package under test, the directory `bun test` runs from, fails the load;
 * other packages, such as `@epicenter/ui`, compile as they ship. `$lib` and
 * `$lib/...` resolve to the importing package's `src/lib`, as SvelteKit's
 * alias does, and stylesheets load as nothing.
 *
 * Run with `--conditions=browser`: Bun's default conditions select Svelte's
 * server runtime, which cannot mount and whose `createSubscriber` and
 * `SvelteMap` notify nothing. Loading this module under other conditions
 * throws. `--conditions=svelte` resolves packages that ship only Svelte
 * sources, such as `mode-watcher` behind `@epicenter/ui/sonner`.
 *
 * This package owns jsdom for its mounted tests and the apps using this harness.
 * jsdom implements no layout, Web Animations, focus order, selection, or
 * IME, so these tests prove what a component renders and what delivered
 * events do, not how a person types.
 *
 * Import this module before anything that loads Svelte, then load components
 * and Svelte's runtime with a dynamic `import()`. SvelteKit's `$app/*`
 * modules have no runtime here: a test that mounts a view importing one
 * stands one in with `mock.module` before loading the view.
 */
import { realpathSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { compile, compileModule } from 'svelte/compiler';

const packageDir = join(import.meta.dir, '..');
const testedPackage = realpathSync(process.cwd()) + sep;
const dependency = `${sep}node_modules${sep}`;

/** Fail on a compiler warning in the package under test; other packages compile as they ship. */
function check(path: string, warnings: readonly { message: string }[]) {
	if (warnings.length === 0) return;
	if (!path.startsWith(testedPackage) || path.includes(dependency)) return;
	throw new Error(
		`${path} compiled with warnings:\n${warnings.map((w) => w.message).join('\n')}`,
	);
}

const isFile = (path: string) =>
	statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;

/** The nearest directory above `file` that holds a `package.json`. */
function packageOf(file: string) {
	let directory = dirname(file);
	while (!isFile(join(directory, 'package.json'))) {
		const parent = dirname(directory);
		if (parent === directory) throw new Error(`No package holds ${file}`);
		directory = parent;
	}
	return directory;
}

Bun.plugin({
	name: 'svelte-dom',
	setup(build) {
		build.onResolve({ filter: /^\$lib(\/|$)/ }, ({ path, importer }) => {
			const target = join(
				packageOf(importer),
				'src/lib',
				path.slice('$lib'.length),
			);
			const found = [
				target,
				target.replace(/\.js$/, '.ts'),
				`${target}.ts`,
				join(target, 'index.ts'),
			].find(isFile);
			if (found === undefined) throw new Error(`No module for ${path}`);
			return { path: found };
		});
		build.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'js' }));
		build.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
			const compiled = compile(await Bun.file(path).text(), {
				filename: path,
				generate: 'client',
			});
			check(path, compiled.warnings);
			return { contents: compiled.js.code, loader: 'js' };
		});
		// Runes modules: a package's `.svelte.ts`, and the `.svelte.js` that
		// packages such as bits-ui ship, as the Svelte Vite plugin compiles both.
		build.onLoad({ filter: /\.svelte\.(ts|js)$/ }, async ({ path }) => {
			const source = await Bun.file(path).text();
			// Dead-code elimination would drop a bare `void signal;`, which is how
			// a derived declares a dependency it does not otherwise read.
			const javascript = path.endsWith('.ts')
				? new Bun.Transpiler({
						loader: 'ts',
						deadCodeElimination: false,
					}).transformSync(source)
				: source;
			const compiled = compileModule(javascript, {
				filename: path,
				generate: 'client',
			});
			check(path, compiled.warnings);
			return { contents: compiled.js.code, loader: 'js' };
		});
	},
});

/** The part of jsdom's surface this module uses; the package installs no jsdom types. */
type Jsdom = {
	JSDOM: new (
		html: string,
		options: { pretendToBeVisual: boolean; url: string },
	) => { window: Window & typeof globalThis };
};

// Loaded synchronously: everything below, the DOM globals included, must be in
// place before the importing test module runs. Bun did not finish a
// top-level await in this side-effect import before evaluating its
// importer, so a plugin or global set after one arrived too late.
const { JSDOM } = require(Bun.resolveSync('jsdom', packageDir)) as Jsdom;

// An origin, so the UI kit's stored preferences have a `localStorage`.
const { window } = new JSDOM('<!doctype html><html><body></body></html>', {
	pretendToBeVisual: true,
	url: 'http://localhost/',
});

// jsdom evaluates no media queries. Every query reads as not matching, so a
// view lays out as on a narrow screen, until `setWide(true)` makes the
// `min-width` queries match.
let wide = false;
const mediaListeners = new Set<(event: Event) => void>();
window.matchMedia ??= (query: string) =>
	({
		get matches() {
			return wide && query.includes('min-width');
		},
		media: query,
		onchange: null,
		addEventListener: (_type: string, listener: (event: Event) => void) =>
			mediaListeners.add(listener),
		removeEventListener: (_type: string, listener: (event: Event) => void) =>
			mediaListeners.delete(listener),
		addListener() {},
		removeListener() {},
		dispatchEvent: () => false,
	}) as unknown as MediaQueryList;

// The DOM classes and globals a component, and the event a test dispatches,
// must share with the document.
for (const name of [
	'window',
	'document',
	'navigator',
	'getComputedStyle',
	'requestAnimationFrame',
	'cancelAnimationFrame',
	'Node',
	'Element',
	'HTMLElement',
	'Text',
	'Comment',
	'DocumentFragment',
	'Event',
	'CustomEvent',
	'InputEvent',
	'KeyboardEvent',
	'MouseEvent',
	'FocusEvent',
	'HTMLInputElement',
	'HTMLTextAreaElement',
	'HTMLButtonElement',
	'MutationObserver',
] as const)
	Object.defineProperty(globalThis, name, {
		configurable: true,
		writable: true,
		value: name === 'window' ? window : window[name],
	});
// Anything else the DOM offers that Bun lacks, such as `SVGElement`,
// `localStorage`, or `getSelection`.
for (const name of Object.getOwnPropertyNames(window))
	if (!(name in globalThis))
		try {
			Object.defineProperty(globalThis, name, {
				configurable: true,
				writable: true,
				value: (window as unknown as Record<string, unknown>)[name],
			});
		} catch {
			// A property jsdom refuses to read outside its window stays absent.
		}
// jsdom lays nothing out; components that measure see nothing change.
globalThis.ResizeObserver ??= class {
	observe() {}
	unobserve() {}
	disconnect() {}
} as unknown as typeof ResizeObserver;
window.Element.prototype.animate ??= function animate() {
	const animation = {
		onfinish: null as (() => void) | null,
		playState: 'finished',
		currentTime: 0,
		effect: {},
		finished: Promise.resolve(),
		cancel() {},
	};
	queueMicrotask(() => animation.onfinish?.());
	return animation as unknown as Animation;
};

if (!Bun.resolveSync('svelte', import.meta.dir).endsWith('index-client.js'))
	throw new Error(
		'Mounted Svelte tests need the browser runtime: run them through the package test script, which passes --conditions=browser.',
	);

/** Cross the width breakpoint: `min-width` media queries match while `next` is true. */
export function setWide(next: boolean) {
	wide = next;
	for (const listener of mediaListeners) listener(new window.Event('change'));
}

/** Set a field's value and dispatch the `input` event a keystroke would. */
export function type(element: Element | null | undefined, value: string) {
	if (
		!(element instanceof window.HTMLInputElement) &&
		!(element instanceof window.HTMLTextAreaElement)
	)
		throw new Error('Expected an input or a textarea');
	element.value = value;
	element.dispatchEvent(new window.Event('input', { bubbles: true }));
}

/** Move focus out of a field, as the person leaving it does. */
export function blur(element: Element | null | undefined) {
	if (!element) throw new Error('Expected an element to leave');
	element.dispatchEvent(new window.FocusEvent('blur'));
}

/** The button under `root` whose text is `text`; pass `document` for one a dialog portals out. */
export function button(root: ParentNode, text: string): HTMLButtonElement {
	const found = [...root.querySelectorAll('button')].find(
		(candidate) => candidate.textContent?.trim() === text,
	);
	if (found === undefined) throw new Error(`No button reads '${text}'`);
	return found;
}

/** Dispatch a click on the button under `root` whose text is `text`. */
export function click(root: ParentNode, text: string) {
	button(root, text).dispatchEvent(
		new window.MouseEvent('click', { bubbles: true }),
	);
}

// CodeMirror reads the document's globals as it loads, so it loads after them.
// SAFETY: jsdom has no layout; the empty list supplies only the geometry CodeMirror asks for.
window.Range.prototype.getClientRects ??= () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as DOMRectList;
// SAFETY: jsdom has no layout; this rectangle stands for an unmeasured range.
window.Range.prototype.getBoundingClientRect ??= () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }) as DOMRect;
const { EditorView } = await import('@codemirror/view');

/** The CodeMirror view an element (its editor, or anything inside it) belongs to. */
function viewOf(element: Element | null | undefined) {
	const editor = element?.closest('.cm-editor');
	const view = editor instanceof window.HTMLElement ? EditorView.findFromDOM(editor) : null;
	if (view === null) throw new Error('Expected an element inside a CodeMirror editor');
	return view;
}

/** What a CodeMirror editor shows, given an element inside it. */
export function editorText(element: Element | null | undefined) {
	return viewOf(element).state.doc.toString();
}

/** Replace what a CodeMirror editor shows with `value`, as typing would. */
export function typeInEditor(element: Element | null | undefined, value: string) {
	const view = viewOf(element);
	view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, userEvent: 'input.type' });
}
