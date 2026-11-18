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

/** Who answered a request that named a root. */
export type Holder = ReturnType<typeof answeredBy>;

/**
 * Who answered a request that named a root: its own serve, another
 * Epicenter's serve, which refuses it with 409, or another program, which
 * does not set `x-epicenter`. A serve from before 0.8 sets no `x-epicenter`
 * and reads as another program.
 */
export function answeredBy(response: Response) {
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
	const marker = join(folder, MARKER);
	return ActionError.NotStarted({
		cause: 'unavailable',
		message:
			holder === 'another Epicenter'
				? `Port ${port} is in use by another Epicenter's serve, not the one for ${folder}. Set a different \`port\` in ${marker}.`
				: `Port ${port} is in use by another program. Set a different \`port\` in ${marker}. If it is an epicenter serve from before an upgrade, stop it and start it again.`,
	});
}

/**
 * The MCP tool name of the action `key` in `app`: the two names joined by
 * `_`. Names have no underscores, so `fromToolName` reads it back.
 */
export const toolName = (app: string, key: string) => `${app}_${key}`;

/** The app and action key a tool name names; an empty key for no such name. */
export function fromToolName(name: string) {
	const [app = '', key = '', ...more] = name.split('_');
	return { app, key: more.length ? '' : key };
}

/** A name that finds no app in the Epicenter: serve's answer, and the command's from the listing. */
export const unknownApp = (name: string) =>
	ActionError.NotStarted({
		cause: 'usage',
		message: `Unknown app "${name}"`,
		next: 'epicenter',
	});

/** An app that does not load, refusing a call or a listing's view of it. */
export const appProblems = (name: string, problems: string[]) =>
	ActionError.NotStarted({
		cause: 'app-problems',
		message: `${name}: ${problems.join('; ')}`,
		app: name,
		problems,
	});
