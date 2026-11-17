/**
 * Send an action to the `epicenter serve` of this home, so that while serve
 * is running it runs every action (ADR-0936). The call is the one a page
 * makes: `POST /<app>/<action>`, answered as JSON lines (ADR-0930).
 */
import { realpath } from 'node:fs/promises';
import { Err } from 'wellcrafted/result';
import type { Answer } from './output.ts';
import { epicenterDir, epicenterRoot } from './root.ts';

/** The header that names the home a call is for, so another home's serve refuses it. */
export const HOME_HEADER = 'x-epicenter-home';

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
 * The answer serve gave, or `undefined` when no serve of this home answers
 * its port, and the caller runs the action itself. Each update goes to
 * `onUpdate` as it arrives.
 */
export async function sendToServe(
	app: string,
	key: string,
	input: Record<string, unknown>,
	onUpdate: (value: unknown) => void,
): Promise<Answer | undefined> {
	const { port } = epicenterRoot();
	// Port 0 asks for any free port, so there is no port to find serve at.
	if (!port) return undefined;
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
	} catch {
		return undefined;
	}
	// Something else has the port: another home's serve, or another program.
	if (response.headers.get(HOME_HEADER) !== (await homeName())) {
		await response.body?.cancel().catch(() => undefined);
		return undefined;
	}
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
