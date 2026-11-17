/**
 * Send an action to the `epicenter serve` of this home, the one process that
 * runs its actions (ADR-0936). The call is the one a page makes:
 * `POST /<app>/<action>`, answered as JSON lines (ADR-0930). A home has one
 * serve, found at the port in its `EPICENTER.md`; a command never starts it
 * and never runs the action in its place.
 */
import { realpath } from 'node:fs/promises';
import { Err } from 'wellcrafted/result';
import type { Answer } from './output.ts';
import { epicenterDir, epicenterRoot } from './root.ts';

/** The header that names the home a call is for, so another home's serve refuses it. */
export const HOME_HEADER = 'x-epicenter-home';

/** The header in which serve states its `epicenter` version beside its home. */
export const VERSION_HEADER = 'x-epicenter-version';

/** This home as the header carries it: its real path, percent-encoded. */
export async function homeName(): Promise<string> {
	return encodeURIComponent(await realpath(epicenterDir()));
}

const cutOff = (): Answer =>
	Err({
		kind: 'fault',
		message:
			'The connection to Epicenter ended before the answer; the action may still be running, or may have finished',
	});

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

/** What sending an action came to. */
export type Sent =
	/**
	 * This home's serve took the call. `version` is the version it states,
	 * `null` for a serve too old to state one, and absent when the connection
	 * ended before serve said anything.
	 */
	| { answer: Answer; version?: string | null }
	/** No answer: nothing answers the port, or another home's serve or another program does. */
	| {
			answer?: undefined;
			port: number;
			holder: 'nothing' | 'epicenter' | 'program';
	  };

/**
 * Send the call to this home's serve and give its answer, or say why there
 * is none. Each update goes to `onUpdate` as it arrives.
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
		return code === 'ECONNREFUSED' || code === 'ConnectionRefused'
			? { port, holder: 'nothing' }
			: { answer: cutOff() };
	}
	// Something else has the port: another home's serve, which names itself, or another program.
	const home = response.headers.get(HOME_HEADER);
	if (home !== (await homeName())) {
		await response.body?.cancel().catch(() => undefined);
		return { port, holder: home === null ? 'program' : 'epicenter' };
	}
	return {
		answer: await readAnswer(response, onUpdate),
		version: response.headers.get(VERSION_HEADER),
	};
}

/** The answer in serve's response: the body of a refusal, or the last of its JSON lines, after each update went to `onUpdate`. */
async function readAnswer(
	response: Response,
	onUpdate: (value: unknown) => void,
): Promise<Answer> {
	if (!response.ok) return (await response.json()) as Answer;
	if (!response.body) return cutOff();
	const lines = response.body.pipeThrough(new TextDecoderStream()).getReader();
	let pending = '';
	try {
		for (;;) {
			const { done, value } = await lines.read();
			pending += value ?? '';
			const whole = pending.split('\n');
			// A last line with no newline was cut off partway.
			pending = whole.pop() ?? '';
			for (const text of whole) {
				if (text === '') continue;
				const line = JSON.parse(text) as { update?: unknown; answer?: Answer };
				if (line.answer) return line.answer;
				onUpdate(line.update);
			}
			if (done) return cutOff();
		}
	} catch {
		return cutOff();
	} finally {
		void lines.cancel().catch(() => undefined);
	}
}
