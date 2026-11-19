/**
 * The command's requests to its home's serve, the one process that loads
 * app code. It reads the listing at `GET /actions/` and calls an action as a
 * page does, with `postAction`. It never starts serve and never runs an
 * action in its place.
 */
import { Err, Ok } from 'wellcrafted/result';
import {
	actionPath,
	fetchServe,
	HOME_HEADER,
	type Listing,
	postAction,
} from '../call.ts';
import { ActionError } from '../errors.ts';
import type { Home } from './home.ts';

/** Where the home's serve answers, and the header that names this home to it. */
const serveOf = (home: Home) => ({
	url: `http://127.0.0.1:${home.port}`,
	headers: { [HOME_HEADER]: encodeURIComponent(home.folder) },
});

/** The listing serve answers at `GET /actions/`. */
export async function fetchListing(home: Home) {
	const { url, headers } = serveOf(home);
	const { data: response, error } = await fetchServe(
		`${url}/actions/`,
		{ headers },
		'The connection to serve ended before its listing',
	);
	if (error !== null) return Err(error);
	// Not JSON is the same as JSON that is no listing.
	const listing = (await response.json().catch(() => undefined)) as
		| Listing
		| undefined;
	if (Array.isArray(listing?.apps)) return Ok(listing);
	return ActionError.Unreachable({ message: 'serve sent an invalid listing' });
}

/**
 * Call `action` of `app` with `input`, its JSON text as typed, and give
 * serve's answer. Serve reads and checks the input. Each update goes to
 * `onUpdate` as it arrives.
 */
export function callServe(
	home: Home,
	app: string,
	action: string,
	input: string,
	onUpdate: (value: unknown) => void,
) {
	const { url, headers } = serveOf(home);
	return postAction(`${url}${actionPath(app, action)}`, input, {
		headers,
		onUpdate,
	});
}
