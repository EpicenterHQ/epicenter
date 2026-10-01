/**
 * Ask the durable controller to flush before the page goes away.
 *
 * A store accepts work live and pays for it afterwards (ADR-0238, amended by
 * ADR-0300), so there is always a window between "the person typed it" and
 * "it is on disk". The controller coalesces normal writes; this hook gives a
 * page lifecycle event one last best-effort flush opportunity.
 *
 * A tab does not close politely. `Cmd+W`, a mobile app switch, and a bfcache
 * navigation all tear the page down with whatever was pending still pending,
 * and no amount of care inside the store can reach past that. What can is the
 * page telling you it is going.
 *
 * ## Why both events, and why not `beforeunload`
 *
 * `beforeunload` is the one everybody reaches for and the wrong one: it is
 * unreliable on mobile, it is ignored for bfcache, and browsers increasingly
 * treat it as a prompt-me hook rather than a lifecycle one.
 * `visibilitychange` is what fires on an app switch and is the most reliable
 * on iOS Safari; `pagehide` is what fires on a bfcache navigation. Listening
 * to both and doing the work twice costs one redundant write and misses
 * nothing, which is the right side to be wrong on.
 *
 * `flush-edits-on-hide.svelte` next door does the OTHER half of this, and the
 * two are easy to confuse. That one blurs the focused element so a
 * commit-on-blur input writes into the store. This one gets the store onto
 * disk. Neither is sufficient alone: the first without the second lands the
 * edit somewhere that is about to be destroyed.
 */

/**
 * The slice of the platform this assumes, declared rather than imported.
 *
 * Same move as `claims.ts`, for the same reason: this module compiles in a
 * program without the DOM library, and writing down the two calls it makes
 * keeps the assumption auditable.
 */
type HideEvents = {
	addEventListener(type: string, listener: () => void): void;
	removeEventListener(type: string, listener: () => void): void;
};

type Page = HideEvents & { readonly visibilityState: string };

function targets(): { page: Page; frame: HideEvents } | undefined {
	const scope = globalThis as unknown as {
		document?: Page;
		addEventListener?: unknown;
		removeEventListener?: unknown;
	};
	if (
		scope.document === undefined ||
		typeof scope.addEventListener !== 'function'
	) {
		return undefined;
	}
	return { page: scope.document, frame: scope as unknown as HideEvents };
}

/**
 * Run `persist` when the page is hidden or torn down. Returns a disposer.
 *
 * A runtime with no page (a test, a worker, Bun) is not an error: there is
 * nothing to hide, so there is nothing to listen to, and the disposer is a
 * no-op. Refusing here would make every non-browser caller handle a failure
 * that means "you are not a browser".
 *
 * `persist` is called for its effect and its result is dropped. It runs while
 * the page is being destroyed, so nothing can await it and nothing can report
 * it; a write that does not finish in time was going to be lost either way,
 * and one that does is the whole point.
 */
export function persistOnHide(persist: () => unknown): () => void {
	const found = targets();
	if (found === undefined) return () => undefined;

	const run = (): void => {
		void persist();
	};
	// `visibilitychange` fires in BOTH directions, so without this guard every
	// return to the tab would write the document again for nothing. `pagehide`
	// only ever means going, so it needs no guard.
	const onVisibility = (): void => {
		if (found.page.visibilityState === 'hidden') run();
	};
	found.page.addEventListener('visibilitychange', onVisibility);
	found.frame.addEventListener('pagehide', run);
	return () => {
		found.page.removeEventListener('visibilitychange', onVisibility);
		found.frame.removeEventListener('pagehide', run);
	};
}
