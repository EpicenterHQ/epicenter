/**
 * The page's route, read from its hash: `#/` is the front page and
 * `#/tasks/<time>` is a task, named by its key, URI-encoded. A link to another
 * route is a plain `href="#/..."`. Every page starts at the top, including
 * back and forward; no scroll position is kept per history entry.
 */
let hash = $state(location.hash);

// Keep the browser's scroll restoration from fighting the reset to the top.
history.scrollRestoration = "manual";

addEventListener("hashchange", () => {
	hash = location.hash;
	scrollTo(0, 0);
});

/** The route's parts after `#/`, each decoded; `[]` for the front page. */
export function currentRoute(): string[] {
	const route = hash.replace(/^#\/?/, "");
	return route === "" ? [] : route.split("/").map(decode);
}

/** A segment decoded, or as written when it is not valid percent-encoding. */
function decode(segment: string) {
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
}
