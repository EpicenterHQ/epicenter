/**
 * Send the command's requests to the `epicenter serve` of this Epicenter, the one
 * process that loads app code and runs its actions (ADR-0936, ADR-0961). The
 * command reads the listing at `GET /actions/`, and calls an action at
 * `POST /actions/<app>/<action>` as a page does, reading its JSON lines with
 * the same `readAnswer` (ADR-0953, ADR-0967). An Epicenter has one serve, found at the port in its
 * `EPICENTER.md`; a command never starts it and never runs an action in its
 * place.
 */
import { join } from 'node:path';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	ActionError,
	type Answer,
	type PublicError,
	readAnswer,
} from '../index.ts';
import { type Listing, ROOT_HEADER, rootHeaderValue } from './protocol.ts';
import { type EpicenterRoot, MARKER } from './root.ts';

/**
 * The command's refusal when serve at `root`'s port answered 409: it serves
 * another Epicenter. It names the folder the command took for its
 * Epicenter and that folder's marker, since a stray `EPICENTER.md` below the
 * real one is the usual cause. Only this computer's terminal prints it.
 */
function anotherEpicenter({ folder, port }: EpicenterRoot) {
	const marker = join(folder, MARKER);
	return ActionError.NotStarted({
		cause: 'unavailable',
		message: `The serve on port ${port} is another Epicenter's. This command took ${folder} for its Epicenter, from ${marker}: if that is not your Epicenter, remove that file; if it is, set a different \`port\` in it.`,
	});
}

/**
 * Send one request to this Epicenter's serve and give its response. With no serve
 * of this Epicenter to take it, the answer is `NotStarted` (`unavailable`); a
 * connection that ends after it was taken is `Unreachable`, saying `ended`.
 * The command sets no time limit: an action owns its own, and a serve that
 * stops answering is the caller's to give up on.
 */
async function reach(
	root: EpicenterRoot,
	path: string,
	init: RequestInit & { headers?: Record<string, string> },
	ended: string,
): Promise<Result<Response, PublicError>> {
	let response: Response;
	try {
		response = await fetch(`http://127.0.0.1:${root.port}${path}`, {
			...init,
			headers: { ...init.headers, [ROOT_HEADER]: rootHeaderValue(root) },
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
		return ActionError.Unreachable({ message: ended });
	}
	if (response.status === 200) return Ok(response);
	await response.body?.cancel().catch(() => undefined);
	if (response.status === 409) return anotherEpicenter(root);
	// Serve refuses a body past its limit before reading it, so nothing ran.
	if (response.status === 413)
		return ActionError.NotStarted({
			cause: 'usage',
			message: 'The input is larger than serve takes',
		});
	// No probe: what answered may be an older serve or another program.
	return ActionError.Unreachable({
		message: `The program on port ${root.port} answered ${`${response.status} ${response.statusText}`.trim()}. If it is this Epicenter's serve from before an upgrade, restart it; if it is another program, set another \`port\` in ${join(root.folder, MARKER)}.`,
	});
}

/** The listing serve answers at `GET /actions/`: every app it loaded, their problems, and the routines. */
export async function fetchListing(
	root: EpicenterRoot,
): Promise<Result<Listing, PublicError>> {
	const { data: response, error } = await reach(
		root,
		'/actions/',
		{},
		'The connection to serve ended before its listing',
	);
	if (error) return Err(error);
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
 * Call the action `action` of `app` with `input`, its JSON text as typed, and
 * give serve's answer. Serve reads and checks the input (ADR-0961). Each
 * update goes to `onUpdate` as it arrives.
 */
export async function callAction(
	root: EpicenterRoot,
	app: string,
	action: string,
	input: string,
	onUpdate: (value: unknown) => void,
): Promise<Answer> {
	const { data: response, error } = await reach(
		root,
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
