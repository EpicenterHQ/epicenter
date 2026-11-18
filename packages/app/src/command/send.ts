/**
 * Send the command's requests to the `epicenter serve` of this Epicenter, the one
 * process that loads app code and runs its actions (ADR-0936, ADR-0961). The
 * command reads the listing at `GET /`, and calls an action at
 * `POST /<app>/<action>` as a page does, reading its JSON lines with the same
 * `readAnswer` (ADR-0953). An Epicenter has one serve, found at the port in its
 * `EPICENTER.md`; a command never starts it and never runs an action in its
 * place.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	ActionError,
	type Answer,
	type PublicError,
	readAnswer,
} from '../index.ts';
import type { Listing } from './listing.ts';
import {
	answeredBy,
	portHeld,
	ROOT_HEADER,
	rootHeaderValue,
} from './protocol.ts';
import type { EpicenterRoot } from './root.ts';

/**
 * How long the command waits for serve's answer to begin. Serve answers a
 * listing once it has loaded every app, and a call once it has loaded the
 * app and checked the input, so this allows a slow load; a listener that
 * takes the connection and never answers is given up on.
 */
const ANSWER_BEGINS_WITHIN_MS = 30_000;

/**
 * Send one request to this Epicenter's serve and give its response. With no serve
 * of this Epicenter to take it, the answer is `NotStarted` (`unavailable`); a
 * connection that ends after it was taken, or that no answer begins on in
 * time, is `Unreachable`, saying `ended`.
 */
async function reach(
	root: EpicenterRoot,
	path: string,
	init: RequestInit & { headers?: Record<string, string> },
	ended: string,
): Promise<Result<Response, PublicError>> {
	const waiting = new AbortController();
	const timer = setTimeout(() => waiting.abort(), ANSWER_BEGINS_WITHIN_MS);
	let response: Response;
	try {
		response = await fetch(`http://127.0.0.1:${root.port}${path}`, {
			...init,
			headers: { ...init.headers, [ROOT_HEADER]: rootHeaderValue(root) },
			signal: waiting.signal,
		});
	} catch (error) {
		// Refused means nothing listens. Any other end came after the request
		// was taken, as when an action ends serve.
		const { code } = error as { code?: string };
		if (code === 'ECONNREFUSED' || code === 'ConnectionRefused')
			return ActionError.NotStarted({
				cause: 'unavailable',
				message: 'serve is not running; if it stopped, its output says why',
				next: 'epicenter serve',
			});
		if (waiting.signal.aborted)
			return ActionError.Unreachable({
				message: `Port ${root.port} took the request and sent no answer within ${ANSWER_BEGINS_WITHIN_MS / 1000} seconds${init.method === 'POST' ? '; the action may still be running, or may have finished' : ''}`,
			});
		return ActionError.Unreachable({ message: ended });
	} finally {
		// Once the answer begins, it may stream for as long as the action runs.
		clearTimeout(timer);
	}
	const holder = answeredBy(response);
	if (holder !== 'its serve') {
		await response.body?.cancel().catch(() => undefined);
		return portHeld(root, holder);
	}
	return Ok(response);
}

/** The listing serve answers at `GET /`: every app it loaded, their problems, and the routines. */
export async function fetchListing(
	root: EpicenterRoot,
): Promise<Result<Listing, PublicError>> {
	const { data: response, error } = await reach(
		root,
		'/',
		{ headers: { accept: 'application/json' } },
		'The connection to serve ended before its listing',
	);
	if (error) return Err(error);
	// A refusal is read as a call's is, and answers only its error.
	if (!response.ok)
		return (await readAnswer(response)) as Result<never, PublicError>;
	try {
		const listing = (await response.json()) as Listing;
		if (Array.isArray(listing?.apps) && Array.isArray(listing.problems))
			return Ok(listing);
	} catch {
		// Not JSON: the same as JSON that is no listing.
	}
	return ActionError.Unreachable({ message: 'serve sent an invalid listing' });
}

/**
 * Call the action `key` of `app` with `input`, its JSON text as typed, and
 * give serve's answer. Serve reads and checks the input (ADR-0961). Each
 * update goes to `onUpdate` as it arrives.
 */
export async function callAction(
	root: EpicenterRoot,
	app: string,
	key: string,
	input: string,
	onUpdate: (value: unknown) => void,
): Promise<Answer> {
	const { data: response, error } = await reach(
		root,
		`/${app}/${key.replaceAll(' ', '.')}`,
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
