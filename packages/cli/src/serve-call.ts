/**
 * Send an action to the `epicenter serve` of this home, the one process that
 * runs its actions (ADR-0936). The call is the one a page makes:
 * `POST /<app>/<action>`, answered as JSON lines (ADR-0930), and read by the
 * same `readAnswer` a page uses (ADR-0953). A home has one serve, found at the
 * port in its `EPICENTER.md`; a command never starts it and never runs the
 * action in its place.
 */
import { realpath } from 'node:fs/promises';
import { ActionError, type Answer, readAnswer } from '@epicenter/app';
import { epicenterDir, epicenterRoot, MARKER } from './root.ts';

/** The header that names the home a call is for, so another home's serve refuses it. */
export const HOME_HEADER = 'x-epicenter-home';

/** The header in which serve states its `epicenter` version beside its home. */
export const VERSION_HEADER = 'x-epicenter-version';

/** This home as the header carries it: its real path, percent-encoded. */
export async function homeName(): Promise<string> {
	return encodeURIComponent(await realpath(epicenterDir()));
}

/**
 * What holds `port` on this computer: `home` is whether it is this home's
 * serve, and `version` is the version it states. `undefined` when nothing
 * there answers HTTP.
 */
export async function whoAnswers(
	port: number,
): Promise<{ home: boolean; version: string | null } | undefined> {
	try {
		// Serve stamps every answer; this one is a 405 that reads no app.
		const response = await fetch(`http://127.0.0.1:${port}/`, {
			method: 'OPTIONS',
			signal: AbortSignal.timeout(2_000),
		});
		await response.body?.cancel().catch(() => undefined);
		return {
			home: response.headers.get(HOME_HEADER) === (await homeName()),
			version: response.headers.get(VERSION_HEADER),
		};
	} catch {
		return undefined;
	}
}

/**
 * What sending an action came to: serve's answer, and the version serve
 * states, `null` for a serve too old to state one. With no serve of this home
 * to take it, the answer is `NotStarted` (`unavailable`) and has no version.
 */
export type Sent = { answer: Answer; version?: string | null };

/** The call never reached this home's serve, so the action did not begin. */
const unavailable = (message: string, next?: string): Sent => ({
	answer: ActionError.NotStarted({ message, cause: 'unavailable', next }),
});

/**
 * Send the call to this home's serve and give its answer. Each update goes to
 * `onUpdate` as it arrives.
 */
export async function sendToServe(
	app: string,
	key: string,
	input: Record<string, unknown>,
	onUpdate: (value: unknown) => void,
): Promise<Sent> {
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
			return unavailable(
				'Epicenter is not running for this home.',
				'epicenter serve',
			);
		return {
			answer: ActionError.Unreachable({
				message:
					'The connection to Epicenter ended before the answer; the action may still be running, or may have finished',
			}),
		};
	}
	// Something else has the port: another home's serve, which names itself, or another program.
	const home = response.headers.get(HOME_HEADER);
	if (home !== (await homeName())) {
		await response.body?.cancel().catch(() => undefined);
		return unavailable(
			`Port ${port} answers for another ${home === null ? 'program' : 'Epicenter'}. Set a different \`port\` in ${MARKER}.`,
		);
	}
	return {
		answer: await readAnswer(response, onUpdate),
		version: response.headers.get(VERSION_HEADER),
	};
}
