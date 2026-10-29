/**
 * Test helper: `$app/navigation` for views mounted outside a SvelteKit app.
 * `goto` asks every `beforeNavigate` hook of a mounted view, as SvelteKit
 * does, and moves the `$app/state` stand-in's URL unless one cancels.
 * `leave` stands in for a reload or a closed tab.
 */
import { onDestroy } from 'svelte';
import { page, setUrl } from './app-state.test-support.svelte.js';

type Navigation = {
	type: 'goto' | 'leave';
	from: { url: URL } | null;
	to: { url: URL } | null;
	cancel(): void;
};

const hooks = new Set<(navigation: Navigation) => void>();

export function beforeNavigate(callback: (navigation: Navigation) => void) {
	hooks.add(callback);
	onDestroy(() => hooks.delete(callback));
}

/** Ask the hooks about a navigation; answers whether it goes ahead. */
function ask(type: Navigation['type'], to: URL | null) {
	let cancelled = false;
	const navigation: Navigation = {
		type,
		from: { url: page.url },
		to: to === null ? null : { url: to },
		cancel() {
			cancelled = true;
		},
	};
	for (const hook of hooks) hook(navigation);
	return !cancelled;
}

export async function goto(
	target: string | URL,
	_options?: {
		replaceState?: boolean;
		keepFocus?: boolean;
		noScroll?: boolean;
	},
) {
	const next = new URL(target, page.url);
	if (ask('goto', next)) setUrl(next);
}

/** The browser leaves the page, as on a reload; answers whether a hook cancelled it. */
export function leave(): boolean {
	return !ask('leave', null);
}

/** Start the next test at `href`, asking no hook. */
export function resetUrl(href = 'http://localhost/') {
	setUrl(new URL(href));
}
