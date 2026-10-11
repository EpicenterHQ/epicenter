/**
 * Mounts Vocab's real Svelte components over a jsdom document in Bun tests.
 *
 * `.svelte` components and `.svelte.ts` runes modules compile for the client
 * the way the Svelte Vite plugin compiles them; a warning in Vocab's own
 * source fails the load. `$lib` resolves to `src/lib` as SvelteKit's alias
 * does. The tests run with `--conditions=browser` so `svelte` resolves to the
 * client runtime a page build uses; under Bun's default conditions it is the
 * server runtime, which cannot mount. Loading this module under other
 * conditions throws.
 *
 * jsdom has no layout, focus model, selection, or IME. These tests show what
 * a delivered event does, not that a person can deliver it.
 *
 * Import this module before anything that loads Svelte, then load Svelte and
 * components with a dynamic `import()`.
 */
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { compile, compileModule } from 'svelte/compiler';

const { window } = new JSDOM('<!doctype html><html><body></body></html>', {
	pretendToBeVisual: true,
	// An origin, so the theme's stored preference has a `localStorage`.
	url: 'http://localhost/',
});

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
	'MouseEvent',
	'PointerEvent',
	'KeyboardEvent',
	'FocusEvent',
	'HTMLInputElement',
	'HTMLTextAreaElement',
	'HTMLButtonElement',
	'MutationObserver',
	'ResizeObserver',
	'localStorage',
	'sessionStorage',
] as const) {
	if (name === 'navigator' && 'navigator' in globalThis) continue;
	Object.defineProperty(globalThis, name, {
		configurable: true,
		writable: true,
		value: name === 'window' ? window : window[name as keyof typeof window],
	});
}
// Every other DOM interface the runtime lacks, such as `HTMLMediaElement`.
for (const name of Object.getOwnPropertyNames(window))
	if (/^[A-Z]/.test(name) && !(name in globalThis))
		Object.defineProperty(globalThis, name, {
			configurable: true,
			writable: true,
			value: (window as unknown as Record<string, unknown>)[name],
		});
window.matchMedia ??= ((query: string) => ({
	matches: false,
	media: query,
	onchange: null,
	addEventListener() {},
	removeEventListener() {},
	addListener() {},
	removeListener() {},
	dispatchEvent: () => false,
})) as typeof window.matchMedia;
Object.assign(globalThis, { matchMedia: window.matchMedia });

if (!Bun.resolveSync('svelte', import.meta.dir).endsWith('index-client.js'))
	throw new Error(
		'Mounted Svelte tests need the browser runtime: run them with `bun run test:svelte`, which passes --conditions=browser.',
	);

const app = join(import.meta.dir, '../../..');
const lib = join(app, 'src/lib');
const own = (path: string) =>
	path.startsWith(app) && !path.includes('node_modules');

function assertNoWarnings(
	path: string,
	warnings: readonly { message: string }[],
) {
	if (own(path) && warnings.length > 0)
		throw new Error(
			`${path} compiled with warnings:\n${warnings.map((w) => w.message).join('\n')}`,
		);
}

Bun.plugin({
	name: 'vocab-svelte-dom',
	setup(build) {
		build.onResolve({ filter: /^\$lib(\/|$)/ }, ({ path }) => ({
			path: join(lib, path.slice('$lib'.length)).replace(/\.js$/, '.ts'),
		}));
		build.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
			const compiled = compile(await Bun.file(path).text(), {
				filename: path,
				generate: 'client',
			});
			assertNoWarnings(path, compiled.warnings);
			return { contents: compiled.js.code, loader: 'js' };
		});
		build.onLoad({ filter: /\.svelte\.(ts|js)$/ }, async ({ path }) => {
			const source = await Bun.file(path).text();
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
			assertNoWarnings(path, compiled.warnings);
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

/** Dispatch the `blur` a field gets when focus leaves it. */
export function leave(element: Element | null | undefined) {
	if (!(element instanceof window.HTMLElement))
		throw new Error('Expected an element');
	element.dispatchEvent(new window.FocusEvent('blur'));
	element.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
}

/** The button whose text reads `text`, if there is one. */
export function button(root: ParentNode, text: string) {
	return [...root.querySelectorAll('button')].find(
		(candidate) => candidate.textContent?.trim() === text,
	);
}

/** Dispatch a click on a button found by its text. */
export function click(root: ParentNode, text: string | Element) {
	const target = typeof text === 'string' ? button(root, text) : text;
	if (target === undefined) throw new Error(`No button reads '${text}'`);
	target.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}
