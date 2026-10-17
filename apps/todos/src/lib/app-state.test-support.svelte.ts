/**
 * Test helper: `$app/state` for views mounted outside a SvelteKit app. The
 * page's URL is reactive state that the `goto` stand-in in
 * `app-navigation.test-support.ts` moves; nothing else changes it.
 */
let url = $state(new URL('http://localhost/'));

/** The part of SvelteKit's `page` the views read. */
export const page = {
	get url() {
		return url;
	},
};

/** Point the page at `next`, as a navigation that went ahead does. */
export function setUrl(next: URL) {
	url = next;
}
