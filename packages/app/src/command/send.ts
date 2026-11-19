/**
 * The command's requests to its home's serve, the one process that loads
 * app code. It reads the listing at `GET /actions/` and calls an action at
 * `POST /actions/<app>/<action>` as a page does, reading the JSON lines with
 * the same `readAnswer`. It never starts serve and never runs an action in
 * its place.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import { type Answer, readAnswer } from '../answer.ts';
import { ActionError, type PublicError } from '../errors.ts';
import type { Home } from './home.ts';
import { HOME_HEADER, type Listing } from './protocol.ts';

/**
 * Send one request to the home's serve. With nothing listening the answer is
 * `NotStarted`; a connection that ends after serve took it is `Unreachable`,
 * saying `ended`. The command sets no time limit.
 */
async function reach(
	home: Home,
	path: string,
	init: RequestInit & { headers?: Record<string, string> },
	ended: string,
): Promise<Result<Response, PublicError>> {
	let response: Response;
	try {
		response = await fetch(`http://127.0.0.1:${home.port}${path}`, {
			...init,
			headers: {
				...init.headers,
				[HOME_HEADER]: encodeURIComponent(home.folder),
			},
		});
	} catch (error) {
		const { code } = error as { code?: string };
		if (code === 'ECONNREFUSED' || code === 'ConnectionRefused')
			return ActionError.NotStarted({
				message: 'serve is not running; if it stopped, its output says why',
				next: 'epicenter serve',
			});
		return ActionError.Unreachable({ message: ended });
	}
	if (response.status === 200) return Ok(response);
	await response.body?.cancel().catch(() => undefined);
	if (response.status === 409)
		return ActionError.NotStarted({
			message: `The serve on port ${home.port} is another home's. Give ${home.folder}/package.json another port.`,
		});
	if (response.status === 413)
		return ActionError.NotStarted({
			message: 'The input is larger than 25 MiB, the most serve takes',
		});
	return ActionError.Unreachable({
		message: `The program on port ${home.port} answered ${`${response.status} ${response.statusText}`.trim()}`,
	});
}

/** The listing serve answers at `GET /actions/`. */
export async function fetchListing(
	home: Home,
): Promise<Result<Listing, PublicError>> {
	const { data: response, error } = await reach(
		home,
		'/actions/',
		{},
		'The connection to serve ended before its listing',
	);
	if (error) return Err(error);
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
export async function callAction(
	home: Home,
	app: string,
	action: string,
	input: string,
	onUpdate: (value: unknown) => void,
): Promise<Answer> {
	const { data: response, error } = await reach(
		home,
		`/actions/${encodeURIComponent(app)}/${encodeURIComponent(action)}`,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: input,
		},
		'The connection to serve ended before the answer; the action may still be running, or may have finished',
	);
	if (error) return Err(error);
	return readAnswer(response, onUpdate);
}
