/**
 * Mounts this package's Svelte components over a jsdom document in Bun tests.
 *
 * Patterned on `apps/todos/src/lib/svelte-dom.test-support.ts`. `.svelte`
 * components and `.svelte.ts` runes modules compile for the client the way
 * the Svelte Vite plugin compiles them; a compiler warning in this package's
 * own files fails the load, while components from other packages, such as
 * `@epicenter/ui`, compile as they ship.
 *
 * Run with `--conditions=browser` (`bun run test`): Bun's default
 * conditions select Svelte's server runtime, which cannot mount. Loading
 * this module under other conditions throws. `--conditions=svelte` resolves
 * packages that ship only Svelte sources, such as `mode-watcher` behind
 * `@epicenter/ui/sonner`.
 *
 * jsdom is the copy `@epicenter/folder` installs for its own mounted tests;
 * this package adds no dependency of its own. jsdom lays nothing out, so
 * these tests prove what a component renders and what delivered events do.
 *
 * Import this module before anything that loads Svelte, then load components
 * and Svelte's runtime with a dynamic `import()`.
 */
import { join } from 'node:path';
import { compile, compileModule } from 'svelte/compiler';

const packageDir = join(import.meta.dir, '..');
const packageSource = join(packageDir, 'src');

/** Fail on a compiler warning in this package's own source; other packages compile as they ship. */
function check(path: string, warnings: readonly { message: string }[]) {
	if (!path.startsWith(packageSource) || warnings.length === 0) return;
	throw new Error(
		`${path} compiled with warnings:\n${warnings.map((w) => w.message).join('\n')}`,
	);
}

Bun.plugin({
	name: 'svelte-package-dom',
	setup(build) {
		build.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
			const compiled = compile(await Bun.file(path).text(), {
				filename: path,
				generate: 'client',
			});
			check(path, compiled.warnings);
			return { contents: compiled.js.code, loader: 'js' };
		});
		// Runes modules: this package's `.svelte.ts`, and the `.svelte.js` that
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

/** The part of jsdom's surface this module uses; the app installs no jsdom types. */
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
const { JSDOM } = require(
	Bun.resolveSync('jsdom', join(packageDir, '../folder')),
) as Jsdom;

const { window } = new JSDOM('<!doctype html><html><body></body></html>', {
	pretendToBeVisual: true,
	url: 'http://localhost/',
});

// jsdom evaluates no media query; the toaster asks for the color scheme.
window.matchMedia ??= (query: string) =>
	({
		matches: false,
		media: query,
		onchange: null,
		addEventListener() {},
		removeEventListener() {},
		addListener() {},
		removeListener() {},
		dispatchEvent: () => false,
	}) as MediaQueryList;

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
// Anything else the DOM offers that Bun lacks, such as `SVGElement`.
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
		cancel() {},
	};
	queueMicrotask(() => animation.onfinish?.());
	return animation as unknown as Animation;
};

if (!Bun.resolveSync('svelte', import.meta.dir).endsWith('index-client.js'))
	throw new Error(
		'Mounted Svelte tests need the browser runtime: run them with `bun run test:mounted`, which passes --conditions=browser.',
	);

/** Set a field's value and dispatch the `input` event a keystroke would. */
export function type(element: Element | null, value: string) {
	if (
		!(element instanceof window.HTMLInputElement) &&
		!(element instanceof window.HTMLTextAreaElement)
	)
		throw new Error('Expected an input or a textarea');
	element.value = value;
	element.dispatchEvent(new window.Event('input', { bubbles: true }));
}

/** Dispatch a click on a button found by its text. */
export function click(root: ParentNode, text: string) {
	const button = [...root.querySelectorAll('button')].find(
		(candidate) => candidate.textContent?.trim() === text,
	);
	if (button === undefined) throw new Error(`No button reads '${text}'`);
	button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}
