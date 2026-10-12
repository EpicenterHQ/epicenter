/**
 * Mounts the app's real Svelte components over a jsdom document in Bun tests.
 *
 * Patterned on `packages/folder/src/svelte/svelte-dom.test-support.ts`.
 * `.svelte` components and `.svelte.ts` runes modules compile for the client
 * the way the Svelte Vite plugin compiles them; a compiler warning in this
 * app's own files fails the load, while components from other packages, such
 * as `@epicenter/ui` and its dependencies, compile as they ship. `$lib/...`
 * resolves to `src/lib` as SvelteKit's alias does.
 *
 * Run with `--conditions=browser` (`bun run test:mounted`): Bun's default
 * conditions select Svelte's server runtime, which cannot mount and whose
 * `createSubscriber` and `SvelteMap` notify nothing. Loading this module
 * under other conditions throws.
 *
 * jsdom is the copy `@epicenter/folder` installs for its own mounted tests;
 * this app adds no dependency of its own. jsdom implements no layout, Web
 * Animations, focus order, selection, or IME, so these tests prove what the
 * component renders and what delivered events do, not how a person types.
 *
 * Import this module before anything that loads Svelte, then take Svelte's
 * runtime from a dynamic `import()`.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { compile, compileModule } from 'svelte/compiler';

const appDir = join(import.meta.dir, '../..');
const libDir = join(appDir, 'src/lib');
const appSource = join(appDir, 'src');
const navigation = join(libDir, 'app-navigation.test-support.ts');

/** Fail on a compiler warning in this app's own source; other packages compile as they ship. */
function check(path: string, warnings: readonly { message: string }[]) {
	if (!path.startsWith(appSource) || warnings.length === 0) return;
	throw new Error(
		`${path} compiled with warnings:\n${warnings.map((w) => w.message).join('\n')}`,
	);
}

Bun.plugin({
	name: 'todos-svelte-dom',
	setup(build) {
		build.onResolve({ filter: /^\$lib\// }, ({ path }) => {
			const resolved = join(libDir, path.slice('$lib/'.length));
			const typescript = resolved.replace(/\.js$/, '.ts');
			return { path: existsSync(typescript) ? typescript : resolved };
		});
		build.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
			const compiled = compile(await Bun.file(path).text(), {
				filename: path,
				generate: 'client',
			});
			check(path, compiled.warnings);
			// SvelteKit's navigation module has no runtime outside a SvelteKit
			// app; a mounted view gets one whose hooks do nothing.
			const contents = compiled.js.code.replaceAll(
				"'$app/navigation'",
				JSON.stringify(navigation),
			);
			return { contents, loader: 'js' };
		});
		// Runes modules: this app's `.svelte.ts`, and the `.svelte.js` that
		// packages such as bits-ui ship, as the Svelte Vite plugin compiles both.
		build.onLoad({ filter: /\.svelte\.(ts|js)$/ }, async ({ path }) => {
			const source = await Bun.file(path).text();
			const javascript = path.endsWith('.ts')
				? new Bun.Transpiler({ loader: 'ts' }).transformSync(source)
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
	Bun.resolveSync('jsdom', join(appDir, '../../packages/folder')),
) as Jsdom;

const { window } = new JSDOM('<!doctype html><html><body></body></html>', {
	pretendToBeVisual: true,
	url: 'http://localhost/',
});

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
// jsdom evaluates no media queries; every query reads as not matching, so
// a view lays out as on a narrow screen.
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
globalThis.matchMedia ??= window.matchMedia;
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
