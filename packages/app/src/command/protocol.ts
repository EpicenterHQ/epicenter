/**
 * What the command and serve agree on over HTTP (ADR-0961): the headers that
 * name an Epicenter and its serve, the largest input a call takes, who holds
 * a port, and what each says when the port is held by someone else. Serve
 * and the sender each import this; neither imports the other.
 */
import { join } from 'node:path';
import { ActionError } from '../index.ts';
import { type EpicenterRoot, MARKER } from './root.ts';

/**
 * The header a request names its Epicenter in: the root's real path,
 * percent-encoded. The command sends it only to 127.0.0.1, so the path never
 * leaves this computer, and serve refuses a request whose root is not its
 * own.
 */
export const ROOT_HEADER = 'x-epicenter-root';

/** The header serve sets to `1` on every answer, naming no path, so a caller can tell an Epicenter's serve from another program. */
export const SERVE_HEADER = 'x-epicenter';

/**
 * The largest input a call takes, in bytes: serve's body limit. The command
 * refuses a larger input before sending it, because Bun answers a larger
 * body with a bare 413 that carries no `x-epicenter`.
 */
export const MAX_INPUT_BYTES = 25 * 1024 * 1024;

/** This Epicenter as the header carries it: its root's real path, percent-encoded. */
export function rootHeaderValue({
	folder,
}: Pick<EpicenterRoot, 'folder'>): string {
	return encodeURIComponent(folder);
}

/**
 * The header a serve from 0.7 or before set on every answer, to its root's
 * real path encoded as `rootHeaderValue` encodes it. Remove it, and the
 * `an older serve` answer, in the release after the first that sends
 * `x-epicenter-root`: by then a serve still running from 0.7 is two
 * upgrades old.
 */
const OLDER_SERVE_HEADER = 'x-epicenter-home';

/** Who answered a request that named a root. */
export type Holder = ReturnType<typeof answeredBy>;

/**
 * Who answered a request that named `root`: its own serve, another
 * Epicenter's serve, which refuses it with 409, its own serve started before
 * an upgrade, or another program, which sets neither header. An older serve
 * of another Epicenter is another Epicenter's.
 */
export function answeredBy(
	response: Response,
	root: Pick<EpicenterRoot, 'folder'>,
) {
	const older = response.headers.get(OLDER_SERVE_HEADER);
	if (older !== null)
		return older === rootHeaderValue(root)
			? 'an older serve'
			: 'another Epicenter';
	if (response.headers.get(SERVE_HEADER) !== '1') return 'another program';
	return response.status === 409 ? 'another Epicenter' : 'its serve';
}

/**
 * The refusal when `root`'s port is held by anyone but its current serve,
 * the same from the command and from a second serve. It names the root the
 * command found, by its marker's full path: a stray `EPICENTER.md` below the
 * real one is a root on the default port, and the message shows which
 * folder was taken. Only this computer's terminal prints it; serve never
 * sends it in an answer, so the path is not hidden.
 */
export function portHeld(
	{ folder, port }: EpicenterRoot,
	holder: Exclude<Holder, 'its serve'>,
) {
	if (holder === 'an older serve')
		return ActionError.NotStarted({
			cause: 'unavailable',
			message: `Port ${port} is in use by a serve started before Epicenter was upgraded; stop it and start it again`,
			next: 'epicenter serve',
		});
	const marker = join(folder, MARKER);
	return ActionError.NotStarted({
		cause: 'unavailable',
		message:
			holder === 'another Epicenter'
				? `Port ${port} is in use by another Epicenter's serve, not the one for ${folder}. Set a different \`port\` in ${marker}.`
				: `Port ${port} is in use by another program. Set a different \`port\` in ${marker}.`,
	});
}
