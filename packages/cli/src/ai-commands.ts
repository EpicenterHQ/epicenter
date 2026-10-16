/**
 * `auth key` and `send`: an AI connection's key in this computer's keychain,
 * and one request sent with it (ADR-0557). What a key entry holds, the
 * endpoint check, the request, and the lines a response becomes are
 * `@epicenter/ai/send`'s; this file reads stdin, prints, and picks the exit
 * code.
 */

import {
	type AccountAccess,
	decodeSendInput,
	type EpicenterAccess,
	keyState,
	removeKey,
	responseEvents,
	type SecretStore,
	type SendError,
	type SendEvent,
	saveKey,
	sendRequest,
} from '@epicenter/ai/send';
import { EXIT, fail, writeJson, writeOut } from './output.ts';

/**
 * `epicenter auth key set|remove|state <id>`. `set` reads
 * `{"endpoint", "key"}` as JSON on stdin, so a key never appears in a
 * process listing; `state` answers without the key.
 */
export async function authKey(
	action: string,
	connection: string,
	json: boolean,
	secrets: SecretStore,
): Promise<number> {
	switch (action) {
		case 'state': {
			const { data, error } = await keyState(secrets, connection);
			if (error !== null) return fail(error.message, json);
			if (json) writeJson(data);
			else
				writeOut(
					data.state === 'missing'
						? `${connection}: no endpoint or key saved on this computer`
						: `${connection}: saved for ${data.endpoint}${data.hasKey ? '' : ' (no key)'}`,
				);
			return EXIT.ok;
		}
		case 'set': {
			let input: unknown;
			try {
				input = JSON.parse(await Bun.stdin.text());
			} catch {
				input = undefined;
			}
			const { data, error } = await saveKey(secrets, connection, input);
			if (error !== null) return fail(error.message, json);
			if (json) writeJson(data);
			else if (data.state === 'saved')
				writeOut(`${connection}: saved for ${data.endpoint}`);
			return EXIT.ok;
		}
		case 'remove': {
			const { data, error } = await removeKey(secrets, connection);
			if (error !== null) return fail(error.message, json);
			if (json) writeJson(data);
			else
				writeOut(
					data.removed
						? `${connection}: removed`
						: `${connection}: nothing was saved`,
				);
			return EXIT.ok;
		}
		default:
			return fail(
				`epicenter auth key takes set, remove, or state, not '${action}'`,
				json,
			);
	}
}

/**
 * `epicenter send`: stdin is one JSON line naming the target and the
 * request, then the body's bytes. An Epicenter connection sends with
 * `epicenter`'s access token and an account request with `account`'s token
 * for its resource (ADR-0549): the desktop grant's under `--desktop`, the
 * device grant's otherwise (ADR-0558). Stdout is NDJSON, one `SendEvent` per
 * line: the response's head, its body in bounded base64 chunks, and `end`,
 * or an `error`. Each line is flushed before the next, so a large response
 * never sits in memory, and the command returns rather than exiting so
 * stdout drains. Exits 0 when a response arrived, whatever its status, and 2
 * when nothing came back.
 */
export async function send(
	secrets: SecretStore,
	epicenter: EpicenterAccess,
	account: AccountAccess,
): Promise<number> {
	const out = Bun.stdout.writer();
	const write = async (event: SendEvent) => {
		out.write(`${JSON.stringify(event)}\n`);
		await out.flush();
	};
	const refuse = async (error: SendError) => {
		await write({ type: 'error', name: error.name, message: error.message });
		return EXIT.unusable;
	};

	const { data: input, error: inputError } = decodeSendInput(
		new Uint8Array(await Bun.stdin.arrayBuffer()),
	);
	if (inputError !== null) return refuse(inputError);
	const { data: response, error } = await sendRequest({
		...input,
		secrets,
		epicenter,
		account,
	});
	if (error !== null) return refuse(error);
	let ended = false;
	for await (const event of responseEvents(response)) {
		await write(event);
		ended = event.type === 'end';
	}
	return ended ? EXIT.ok : EXIT.unusable;
}
