/**
 * The page's route, read from its hash: `#/` is the front page and
 * `#/data/<collection>/<file>.md` is a record, each segment URI-encoded. A
 * link to another route is a plain `href="#/..."`. Every page starts at the
 * top, including back and forward; no scroll position is kept per history entry.
 */
import { tick } from "svelte";

let hash = $state(location.hash);

// Keep the browser's scroll restoration from fighting the reset to the top.
history.scrollRestoration = "manual";

addEventListener("hashchange", () => {
	hash = location.hash;
	void tick().then(() => scrollTo(0, 0));
});

/** The path the hash names, decoded, or `''` for the front page: `data/tasks/<time>.md`. */
export function currentPath(): string {
	return hash.replace(/^#\/?/, "").split("/").map(decode).join("/");
}

/** A segment decoded, or as written when it is not valid percent-encoding. */
function decode(segment: string) {
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
}
