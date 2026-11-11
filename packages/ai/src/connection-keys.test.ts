/**
 * The keys in a Tauri window (`connection-keys.ts` when `isTauri()`): the
 * shell holds each connection's key in the app's credentials file, over a
 * recording shell.
 *
 * Key behaviors:
 * - The keys say the shell sends each request (`relayed`)
 * - A key and its endpoint are handed to the shell; the page holds none
 * - A connection's endpoint sends through the shell by its id
 * - Moving a key sends both endpoint addresses to the shell, which decides
 *   whether the saved key may move
 */
import { expect, mock, test } from 'bun:test';

const commands: { name: string; args?: Record<string, unknown> }[] = [];

mock.module('@tauri-apps/api/core', () => ({
	isTauri: () => true,
	Channel: class {
		constructor(public onmessage?: (message: unknown) => void) {}
	},
	transformCallback: () => 0,
	invoke: async (command: string, args?: Record<string, unknown>) => {
		commands.push({ name: command, args });
		switch (command) {
			case 'connection_key_set':
			case 'connection_key_move':
				return null;
			case 'connection_fetch': {
				const onEvent = args?.onEvent as {
					onmessage: (message: unknown) => void;
				};
				queueMicrotask(() => {
					onEvent.onmessage({ kind: 'head', status: 200, headers: [] });
					onEvent.onmessage({ kind: 'end' });
				});
				return null;
			}
			default:
				throw new Error(`unexpected ${command}`);
		}
	},
}));

const { connectionKeys } = await import('./connection-keys.js');

const record = {
	id: 'c1',
	name: 'Mine',
	baseUrl: 'https://api.example.com/v1',
	models: ['m'],
};

test('a key goes to the shell with its endpoint, and a request goes through the shell by id', async () => {
	commands.length = 0;
	expect(connectionKeys.relayed).toBe(true);
	await connectionKeys.set('c1', record.baseUrl, 'sk-secret');
	expect(commands).toEqual([
		{
			name: 'connection_key_set',
			args: { id: 'c1', endpoint: record.baseUrl, key: 'sk-secret' },
		},
	]);
	expect(connectionKeys.keyOf(record)).toBeUndefined();
	const endpoint = connectionKeys.endpoint(record);
	const response = await endpoint.fetch?.(`${record.baseUrl}/models`);
	expect(response?.status).toBe(200);
	expect(commands.at(-1)).toMatchObject({
		name: 'connection_fetch',
		args: { request: { connection: 'c1', url: `${record.baseUrl}/models` } },
	});
	await connectionKeys.set('c1', '', null);
	expect(commands.at(-1)).toEqual({
		name: 'connection_key_set',
		args: { id: 'c1', endpoint: '', key: null },
	});
});

test('moving a key sends its former and new endpoint to the shell', async () => {
	commands.length = 0;
	await connectionKeys.move('c1', 'https://a.test/v1', 'https://b.test/v1');
	expect(commands).toEqual([
		{
			name: 'connection_key_move',
			args: { id: 'c1', from: 'https://a.test/v1', to: 'https://b.test/v1' },
		},
	]);
});
