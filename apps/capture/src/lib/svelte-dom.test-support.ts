/**
 * Mounts Capture's real Svelte components over a jsdom document in Bun tests.
 *
 * `.svelte` components and `.svelte.ts` runes modules compile for the client
 * as the Svelte Vite plugin compiles them, and `$lib/` resolves to
 * `src/lib/` as in the SvelteKit build. A warning in this app's own
 * components fails the load. Run with `--conditions=browser` (the
 * `test:mounted` script), so `svelte` resolves to the client runtime a page
 * build uses; this module throws otherwise.
 *
 * jsdom lays nothing out, and has no focus, selection, or IME behavior:
 * these tests show what a delivered event does to the draft, not that a
 * person can type there.
 *
 * Import this module before anything that loads Svelte, then load
 * components with a dynamic `import()`.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { compile, compileModule } from 'svelte/compiler';

const { window } = new JSDOM('<!doctype html><html><body></body></html>', {
	pretendToBeVisual: true,
	// Web storage needs an origin; the UI kit's theme reads it.
	url: 'http://localhost/',
});
// A desktop-width window: `min-width` queries match, so the UI kit's modal
// renders as a dialog, as it does in the desktop app.
window.matchMedia ??= (query: string) =>
	({
		matches: /min-width/.test(query),
		media: query,
		onchange: null,
		addEventListener() {},
		removeEventListener() {},
		addListener() {},
		removeListener() {},
		dispatchEvent: () => false,
	}) as MediaQueryList;

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
	'MutationObserver',
	'ResizeObserver',
	'localStorage',
	'sessionStorage',
	'matchMedia',
] as const) {
	Object.defineProperty(globalThis, name, {
		configurable: true,
		writable: true,
		value:
			name === 'window'
				? window
				: name === 'ResizeObserver'
					? class {
							observe() {}
							unobserve() {}
							disconnect() {}
						}
					: (window as unknown as Record<string, unknown>)[name],
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

if (!Bun.resolveSync('svelte', import.meta.dir).endsWith('index-client.js'))
	throw new Error(
		'Mounted Svelte tests need the browser runtime: run them with `bun run test:mounted`, which passes --conditions=browser.',
	);

const LIB = import.meta.dir;
const ownSource = (path: string) => path.startsWith(join(LIB, '..'));

function assertNoWarnings(
	path: string,
	warnings: readonly { message: string }[],
) {
	if (ownSource(path) && warnings.length > 0)
		throw new Error(
			`${path} compiled with warnings:\n${warnings.map((w) => w.message).join('\n')}`,
		);
}

Bun.plugin({
	name: 'capture-svelte-dom',
	setup(build) {
		build.onResolve({ filter: /^\$lib\// }, ({ path }) => {
			const target = join(LIB, path.slice('$lib/'.length));
			const typescript = target.replace(/\.js$/, '.ts');
			return { path: existsSync(target) ? target : typescript };
		});
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
				? new Bun.Transpiler({ loader: 'ts' }).transformSync(source)
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

/** Move focus out of a field, as the person leaving it does. */
export function blur(element: Element | null | undefined) {
	if (!element) throw new Error('Expected an element to leave');
	element.dispatchEvent(new window.FocusEvent('blur'));
}

/** The button whose text is `text`, anywhere in the document (dialogs render in a portal). */
export function button(text: string): HTMLButtonElement {
	const found = [...document.querySelectorAll('button')].find(
		(candidate) => candidate.textContent?.trim() === text,
	);
	if (found === undefined) throw new Error(`No button reads '${text}'`);
	return found;
}

/** Dispatch the click a press would. */
export function click(element: Element) {
	element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}

/**
 * Dispatch the submit event a form delivers, on the form itself. A detached
 * form still delivers it to the listeners Svelte left on it.
 */
export function submit(form: Element | null | undefined) {
	if (!(form instanceof window.HTMLFormElement))
		throw new Error('Expected a form');
	form.dispatchEvent(
		new window.Event('submit', { bubbles: true, cancelable: true }),
	);
}

/** The textarea or input with this id, or `null`. */
export const field = (id: string) =>
	document.getElementById(id) as HTMLTextAreaElement | null;
