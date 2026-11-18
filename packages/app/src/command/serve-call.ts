/**
 * Send the command's requests to the `epicenter serve` of this home, the one
 * process that loads app code and runs its actions (ADR-0936, ADR-0961). The
 * command reads the listing at `GET /`, and sends the words it was typed to
 * `POST /<app>`, whose answer is JSON lines read by the same `readAnswer` a
 * page uses (ADR-0953). A home has one serve, found at the port in its
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
import { type EpicenterRoot, MARKER } from './root.ts';
/** The header that names the home a call is for, so another home's serve refuses it. */
export const HOME_HEADER = 'x-epicenter-home';

/** This home as the header carries it: its real path, percent-encoded. */
export function homeName({ folder }: Pick<EpicenterRoot, 'folder'>): string {
	return encodeURIComponent(folder);
}

/**
 * What holds `port` on this computer: `home` is whether it is this home's
 * serve. `undefined` when nothing there answers HTTP.
 */
export async function whoAnswers(
	root: EpicenterRoot,
): Promise<{ home: boolean } | undefined> {
	try {
		// Serve stamps every answer; this one is a 405 that reads no app.
		const response = await fetch(`http://127.0.0.1:${root.port}/`, {
			method: 'OPTIONS',
			signal: AbortSignal.timeout(2_000),
		});
		await response.body?.cancel().catch(() => undefined);
		return { home: response.headers.get(HOME_HEADER) === homeName(root) };
	} catch {
		return undefined;
	}
}

/**
 * Send one request to this home's serve and give its response. With no serve
 * of this home to take it, the answer is `NotStarted` (`unavailable`); a
 * connection that ends after it was taken is `Unreachable`, saying `ended`.
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
			headers: { ...init.headers, [HOME_HEADER]: homeName(root) },
		});
	} catch (error) {
		// Refused means nothing listens. Any other end came after the request
		// was taken, as when an action ends serve.
		const { code } = error as { code?: string };
		if (code === 'ECONNREFUSED' || code === 'ConnectionRefused')
			return ActionError.NotStarted({
				cause: 'unavailable',
				message: 'serve is not running; its output says why it stopped',
				next: 'epicenter serve',
			});
		return ActionError.Unreachable({ message: ended });
	}
	// Something else has the port: another home's serve, which names itself, or another program.
	const home = response.headers.get(HOME_HEADER);
	if (home !== homeName(root)) {
		await response.body?.cancel().catch(() => undefined);
		return ActionError.NotStarted({
			cause: 'unavailable',
			message: `Port ${root.port} answers for another ${home === null ? 'program' : 'Epicenter'}. Set a different \`port\` in ${MARKER}.`,
		});
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
	const invalid = () =>
		ActionError.Unreachable({ message: 'serve sent an invalid listing' });
	// A refusal is a NotStarted in the body, read as a call's is.
	if (!response.ok) {
		const { error: refusal } = await readAnswer(response);
		return refusal ? Err(refusal) : invalid();
	}
	try {
		const listing = (await response.json()) as Listing;
		if (Array.isArray(listing?.apps) && Array.isArray(listing.problems))
			return Ok(listing);
	} catch {
		// Not JSON: the same as JSON that is no listing.
	}
	return invalid();
}

/**
 * Send the words typed after the app's name to serve, and give its answer.
 * Serve finds the action and reads its input (ADR-0961). With `help`, the
 * answer is the action's tool and nothing runs; otherwise each update goes
 * to `onUpdate` as it arrives.
 */
export async function sendWords(
	root: EpicenterRoot,
	app: string,
	words: string[],
	{ help, onUpdate }: { help: boolean; onUpdate?: (value: unknown) => void },
): Promise<Answer> {
	const { data: response, error } = await reach(
		root,
		`/${encodeURIComponent(app)}`,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(help ? { words, help } : { words }),
		},
		help
			? 'The connection to serve ended before its answer'
			: 'The connection to Epicenter ended before the answer; the action may still be running, or may have finished',
	);
	if (error) return Err(error);
	return readAnswer(response, onUpdate);
}
