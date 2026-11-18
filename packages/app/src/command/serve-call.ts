/**
 * Send an action to the `epicenter serve` of this home, the one process that
 * runs its actions (ADR-0936). The call is the one a page makes:
 * `POST /<app>/<action>`, answered as JSON lines (ADR-0930), and read by the
 * same `readAnswer` a page uses (ADR-0953). A home has one serve, found at the
 * port in its `EPICENTER.md`; a command never starts it and never runs the
 * action in its place.
 */
import { realpath } from 'node:fs/promises';
import { ActionError, type Answer, readAnswer } from '../index.ts';
import { epicenterDir, epicenterRoot, MARKER } from './root.ts';

/** The header that names the home a call is for, so another home's serve refuses it. */
export const HOME_HEADER = 'x-epicenter-home';

/** This home as the header carries it: its real path, percent-encoded. */
export async function homeName(): Promise<string> {
	return encodeURIComponent(await realpath(epicenterDir()));
}

/**
 * What holds `port` on this computer: `home` is whether it is this home's
 * serve. `undefined` when nothing there answers HTTP.
 */
export async function whoAnswers(
	port: number,
): Promise<{ home: boolean } | undefined> {
	try {
		// Serve stamps every answer; this one is a 405 that reads no app.
		const response = await fetch(`http://127.0.0.1:${port}/`, {
			method: 'OPTIONS',
			signal: AbortSignal.timeout(2_000),
		});
		await response.body?.cancel().catch(() => undefined);
		return { home: response.headers.get(HOME_HEADER) === (await homeName()) };
	} catch {
		return undefined;
	}
}

/**
 * Send the call to this home's serve and give its answer. Each update goes to
 * `onUpdate` as it arrives. With no serve of this home to take it, the answer
 * is `NotStarted` (`unavailable`).
 */
export async function sendToServe(
	app: string,
	key: string,
	input: Record<string, unknown>,
	onUpdate: (value: unknown) => void,
): Promise<Answer> {
	const { port } = epicenterRoot();
	let response: Response;
	try {
		response = await fetch(
			`http://127.0.0.1:${port}/${app}/${key.split(' ').join('.')}`,
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					[HOME_HEADER]: await homeName(),
				},
				body: JSON.stringify(input),
			},
		);
	} catch (error) {
		// Refused means nothing listens. Any other end came after the call was
		// taken, as when the action ends serve, so the action may have run.
		const { code } = error as { code?: string };
		if (code === 'ECONNREFUSED' || code === 'ConnectionRefused')
			return ActionError.NotStarted({
				cause: 'unavailable',
				message: 'serve is not running; its output says why it stopped',
				next: 'epicenter serve',
			});
		return ActionError.Unreachable({
			message:
				'The connection to Epicenter ended before the answer; the action may still be running, or may have finished',
		});
	}
	// Something else has the port: another home's serve, which names itself, or another program.
	const home = response.headers.get(HOME_HEADER);
	if (home !== (await homeName())) {
		await response.body?.cancel().catch(() => undefined);
		return ActionError.NotStarted({
			cause: 'unavailable',
			message: `Port ${port} answers for another ${home === null ? 'program' : 'Epicenter'}. Set a different \`port\` in ${MARKER}.`,
		});
	}
	return readAnswer(response, onUpdate);
}
