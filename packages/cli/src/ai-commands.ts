/**
 * `auth key` and `send`: this computer's AI connections, in
 * `connections.json` with each key in the keychain (ADR-0587,
 * `connections.ts`), and one request sent over one (ADR-0557). What a key
 * entry holds, the endpoint check, the request, and the lines a response
 * becomes are `@epicenter/ai/send`'s; this file reads stdin, prints, and
 * picks the exit code.
 */

import {
	type AccountAccess,
	decodeSendInput,
	type EpicenterAccess,
	keyState,
	responseEvents,
	type SecretStore,
	type SendError,
	type SendEvent,
	sendRequest,
} from '@epicenter/ai/send';
import type { AppPaths } from './app-paths.ts';
import {
	type ListedConnection,
	listConnections,
	removeConnection,
	setConnection,
	useConnection,
} from './connections.ts';
import { EXIT, fail, writeJson, writeOut } from './output.ts';

/** One listed connection as a line for people: never the key. */
function describeConnection({ id, kind, title, model, key }: ListedConnection) {
	const columns = [id, kind, JSON.stringify(title), model || '(no model)'];
	if (key === null) return columns.join('  ');
	switch (key.state) {
		case 'missing':
			return [...columns, 'key missing'].join('  ');
		case 'saved':
			return [
				...columns,
				key.endpoint,
				...(key.hasKey ? [] : ['(no key)']),
			].join('  ');
		case 'unreadable':
			return [...columns, `keychain entry unreadable: ${key.message}`].join(
				'  ',
			);
	}
}

/**
 * `epicenter auth key list|set|remove|state|use [<id>]`. `list` prints every
 * connection with its endpoint and whether its key is saved, never the key.
 * `set` reads the connection's `{"kind", "title", "model", "endpoint",
 * "key"}`, each optional, as JSON on stdin, so a key never appears in a
 * process listing. `use` records which connection an app uses for an
 * operation.
 */
export async function authKey(
	action: string,
	connection: string | undefined,
	options: Record<string, string | true>,
	json: boolean,
	secrets: SecretStore,
	paths: AppPaths,
): Promise<number> {
	if (action === 'list') {
		if (connection !== undefined)
			return fail('epicenter auth key list takes no connection id', json);
		const { data, error } = await listConnections(paths, secrets);
		if (error !== null) return fail(error.message, json);
		if (json) writeJson(data);
		else if (data.connections.length === 0)
			writeOut('No AI connections on this computer.');
		else {
			writeOut(data.connections.map(describeConnection).join('\n'));
			for (const [app, uses] of Object.entries(data.apps))
				for (const [operation, id] of Object.entries(uses))
					writeOut(`${app} uses ${id} for ${operation}`);
		}
		return EXIT.ok;
	}
	if (connection === undefined)
		return fail(`epicenter auth key ${action} needs a connection id`, json);
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
			const { data, error } = await setConnection(
				paths,
				secrets,
				connection,
				input,
			);
			if (error !== null) return fail(error.message, json);
			if (json) writeJson(data);
			else writeOut(describeConnection(data));
			return EXIT.ok;
		}
		case 'remove': {
			const { data, error } = await removeConnection(
				paths,
				secrets,
				connection,
			);
			if (error !== null) return fail(error.message, json);
			if (json) writeJson(data);
			else
				writeOut(
					data.removed
						? `${connection}: removed`
						: `${connection}: there was no such connection`,
				);
			return EXIT.ok;
		}
		case 'use': {
			const { app, operation } = options;
			if (typeof app !== 'string' || typeof operation !== 'string')
				return fail(
					'epicenter auth key use <id> needs --app <app-id> and --operation <name>',
					json,
				);
			const { data, error } = await useConnection(paths, {
				id: connection,
				app,
				operation,
			});
			if (error !== null) return fail(error.message, json);
			if (json) writeJson(data);
			else writeOut(`${data.app} uses ${data.id} for ${data.operation}`);
			return EXIT.ok;
		}
		default:
			return fail(
				`epicenter auth key takes list, set, remove, state, or use, not '${action}'`,
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
