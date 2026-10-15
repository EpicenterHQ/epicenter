/**
 * Mounts Honeycrisp's real Svelte components over a jsdom document in Bun
 * tests: the components the page renders, with their UI library.
 *
 * `.svelte` components and `.svelte.ts` runes modules compile for the client
 * the way the Svelte Vite plugin compiles them. A warning in one of the
 * app's own components fails the load; one in a dependency is not this
 * app's to fix. `$lib` resolves as SvelteKit resolves it, and stylesheets
 * load as nothing. Tests that import this run with the `browser` and
 * `svelte` conditions, which the page build resolves with, so `svelte` is
 * the client runtime and Svelte libraries resolve to their components.
 *
 * jsdom has no layout, focus, selection, IME, or assistive technology: these
 * tests show what a delivered event does, not that a person can type there.
 *
 * Import this module before anything that loads Svelte, take Svelte's
 * runtime from a dynamic `import('svelte')`, and load components with a
 * dynamic `import()`.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { compile, compileModule } from 'svelte/compiler';

const LIB = import.meta.dir;

// An origin, so the UI library's stored preferences have a `localStorage`.
// Nothing here awaits at the top: that would delay the plugin below past the
// imports that need it.
const window = new JSDOM('<!doctype html><html><body></body></html>', {
	pretendToBeVisual: true,
	url: 'http://localhost/',
}).window as unknown as Window & typeof globalThis;

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
	'PointerEvent',
	'HTMLInputElement',
	'HTMLTextAreaElement',
	'HTMLSelectElement',
	'MutationObserver',
	'Range',
	'Selection',
	'getSelection',
	'localStorage',
	'matchMedia',
] as const) {
	const value = name === 'window' ? window : window[name];
	if (value === undefined) continue;
	Object.defineProperty(globalThis, name, {
		configurable: true,
		writable: true,
		value:
			typeof value === 'function' && /^(get|match)/.test(name)
				? (value as (...args: unknown[]) => unknown).bind(window)
				: value,
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
// The UI library asks for the color scheme; jsdom answers no query.
window.matchMedia ??= ((query: string) => ({
	matches: false,
	media: query,
	onchange: null,
	addListener() {},
	removeListener() {},
	addEventListener() {},
	removeEventListener() {},
	dispatchEvent: () => false,
})) as typeof window.matchMedia;
globalThis.matchMedia ??= window.matchMedia;
// Neither is in jsdom; the UI library observes sizes and Svelte animates.
globalThis.ResizeObserver ??= class {
	observe() {}
	unobserve() {}
	disconnect() {}
} as unknown as typeof ResizeObserver;
window.Element.prototype.animate ??= function animate() {
	const animation = {
		onfinish: null as (() => void) | null,
		playState: 'finished',
		cancel() {},
		finished: Promise.resolve(),
	};
	queueMicrotask(() => animation.onfinish?.());
	return animation as unknown as Animation;
};

if (!Bun.resolveSync('svelte', import.meta.dir).endsWith('index-client.js'))
	throw new Error(
		'Mounted Svelte tests need the browser runtime: run them with --conditions=browser --conditions=svelte.',
	);

const own = (path: string) => !path.includes('/node_modules/');

function check(path: string, warnings: readonly { message: string }[]) {
	if (own(path) && warnings.length > 0)
		throw new Error(
			`${path} compiled with warnings:\n${warnings.map((w) => w.message).join('\n')}`,
		);
}

Bun.plugin({
	name: 'honeycrisp-svelte-dom',
	setup(build) {
		build.onResolve({ filter: /^\$lib\// }, ({ path }) => {
			const relative = path.slice('$lib/'.length);
			const candidates = [
				relative,
				relative.replace(/\.js$/, '.ts'),
				`${relative}.ts`,
			];
			const found = candidates
				.map((candidate) => join(LIB, candidate))
				.find((candidate) => existsSync(candidate));
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
		const runes = async ({ path }: { path: string }) => {
			const source = await Bun.file(path).text();
			const javascript = path.endsWith('.ts')
				? new Bun.Transpiler({ loader: 'ts' }).transformSync(source)
				: source;
			const compiled = compileModule(javascript, {
				filename: path,
				generate: 'client',
			});
			check(path, compiled.warnings);
			return { contents: compiled.js.code, loader: 'js' as const };
		};
		build.onLoad({ filter: /\.svelte\.ts$/ }, runes);
		build.onLoad({ filter: /\.svelte\.js$/ }, runes);
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
export function leave(element: Element) {
	element.dispatchEvent(new window.FocusEvent('blur'));
}

/** Dispatch a click on the button whose text is `text`. */
export function click(root: ParentNode, text: string) {
	const button = buttonNamed(root, text);
	if (button === undefined) throw new Error(`No button reads '${text}'`);
	button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	return button;
}

/** The button whose text is `text`, if there is one. */
export function buttonNamed(root: ParentNode, text: string) {
	return [...root.querySelectorAll('button')].find(
		(candidate) => candidate.textContent?.trim() === text,
	);
}
