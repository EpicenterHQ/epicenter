/**
 * Mounts the page's real Svelte components over a jsdom document in Bun
 * tests.
 *
 * `.svelte` components and `.svelte.ts` runes modules compile for the client
 * the way the Svelte Vite plugin compiles them, and `$lib` resolves as
 * SvelteKit resolves it. `$app/navigation` and `$app/paths` are stand-ins
 * that navigate nowhere. The tests run with `--conditions=browser`
 * (`bun run test:mounted`), so `svelte` is the client runtime a page build
 * uses; the server runtime cannot mount.
 *
 * jsdom has no layout, focus, selection, IME, or assistive technology. These
 * tests show what a delivered event does to the app's state, not that a
 * person can deliver it.
 *
 * Import this module before anything that loads Svelte, then load
 * components and runes modules with a dynamic `import()`.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { compile, compileModule } from 'svelte/compiler';

const { window } = new JSDOM('<!doctype html><html><body></body></html>', {
	pretendToBeVisual: true,
	url: 'http://127.0.0.1/',
}) as unknown as { window: Window & typeof globalThis };

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
	'PointerEvent',
	'FocusEvent',
	'HTMLInputElement',
	'HTMLTextAreaElement',
	'HTMLButtonElement',
	'MutationObserver',
	'ResizeObserver',
	'localStorage',
	'sessionStorage',
] as const) {
	const value =
		name === 'window'
			? window
			: name === 'ResizeObserver'
				? class {
						observe() {}
						unobserve() {}
						disconnect() {}
					}
				: (window as unknown as Record<string, unknown>)[name];
	if (value === undefined) continue;
	Object.defineProperty(globalThis, name, {
		configurable: true,
		writable: true,
		value,
	});
}
// Every element and event class the components and their libraries may name.
for (const name of Object.getOwnPropertyNames(window))
	if (/^(HTML|SVG)\w*Element$|^\w+Event$/.test(name) && !(name in globalThis))
		Object.defineProperty(globalThis, name, {
			configurable: true,
			writable: true,
			value: (window as unknown as Record<string, unknown>)[name],
		});
// The audio player makes object URLs for bytes it read; jsdom has none.
URL.createObjectURL ??= () => 'blob:mounted-test';
URL.revokeObjectURL ??= () => {};
window.matchMedia ??= (query: string) =>
	({
		matches: false,
		media: query,
		addEventListener() {},
		removeEventListener() {},
	}) as unknown as MediaQueryList;
window.Element.prototype.animate ??= function animate() {
	const animation = {
		onfinish: null as (() => void) | null,
		currentTime: 0,
		playState: 'finished',
		cancel() {},
	};
	queueMicrotask(() => animation.onfinish?.());
	return animation as unknown as Animation;
};

if (!Bun.resolveSync('svelte', import.meta.dir).endsWith('index-client.js'))
	throw new Error(
		'Mounted tests need the browser runtime: run them with `bun run test:mounted`, which passes --conditions=browser.',
	);

const lib = fileURLToPath(new URL('../lib', import.meta.url));

Bun.plugin({
	name: 'whispering-svelte-dom',
	setup(build) {
		build.onResolve({ filter: /^\$lib(\/|$)/ }, ({ path }) => ({
			path: join(lib, path.slice('$lib'.length)).replace(/\.js$/, '.ts'),
		}));
		build.module('$app/state', () => ({
			exports: {
				page: { url: new URL('http://localhost/'), route: { id: '/' } },
			},
			loader: 'object',
		}));
		build.module('$app/paths', () => ({
			exports: { base: '', resolve: (route: string) => route },
			loader: 'object',
		}));
		build.module('$app/navigation', () => ({
			exports: {
				goto: async () => {},
				beforeNavigate: () => {},
				afterNavigate: () => {},
			},
			loader: 'object',
		}));
		build.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
			const compiled = compile(await Bun.file(path).text(), {
				filename: path,
				generate: 'client',
			});
			return { contents: compiled.js.code, loader: 'js' };
		});
		// Runes modules: the page's own `.svelte.ts`, and `.svelte.js` that libraries ship.
		build.onLoad({ filter: /\.svelte\.(ts|js)$/ }, async ({ path }) => {
			const source = await Bun.file(path).text();
			const javascript = path.endsWith('.ts')
				? new Bun.Transpiler({ loader: 'ts' }).transformSync(source)
				: source;
			const compiled = compileModule(javascript, {
				filename: path,
				generate: 'client',
			});
			return { contents: compiled.js.code, loader: 'js' };
		});
	},
});

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
export function leave(element: Element | null | undefined) {
	if (!element) throw new Error('Expected an element to leave');
	element.dispatchEvent(new window.FocusEvent('blur'));
}

/** Dispatch a click on a button found by its text. */
export function click(root: ParentNode, text: string) {
	const button = [...root.querySelectorAll('button')].find(
		(candidate) => candidate.textContent?.trim() === text,
	);
	if (button === undefined) throw new Error(`No button reads '${text}'`);
	button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}
