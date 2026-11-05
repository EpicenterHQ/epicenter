/**
 * The desktop's keys (`device-settings.tauri.ts`): the shell holds each
 * connection's key, over a stand-in shell.
 *
 * Key behaviors:
 * - A key is handed to the shell with the endpoint it was entered for; the
 *   page holds none, and a connection's endpoint sends through the shell by
 *   its id
 * - Moving a key to a changed endpoint keeps it only when it was entered
 *   for the endpoint it moves from
 */
import { expect, mock, test } from 'bun:test';

const kept = new Map<string, string>();
const relayed: { connection?: string | null; url: string }[] = [];

mock.module('@tauri-apps/api/core', () => ({
	isTauri: () => true,
	Channel: class {
		constructor(public onmessage?: (message: unknown) => void) {}
	},
	transformCallback: () => 0,
	invoke: async (command: string, args?: Record<string, unknown>) => {
		switch (command) {
			case 'keychain_get':
				return Object.fromEntries(
					(args as { names: string[] }).names
						.filter((name) => kept.has(name))
						.map((name) => [name, kept.get(name)]),
				);
			case 'keychain_set': {
				const value = args?.value as string | null;
				if (value === null) kept.delete(args?.name as string);
				else kept.set(args?.name as string, value);
				return null;
			}
			case 'connection_fetch': {
				const request = args?.request as {
					connection?: string | null;
					url: string;
				};
				relayed.push({ connection: request.connection, url: request.url });
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

const { connectionKeys } = await import('./device-settings.tauri.js');

const record = {
	id: 'c1',
	name: 'Mine',
	baseUrl: 'https://api.example.com/v1',
	models: ['m'],
};

test('a key goes to the shell with its endpoint, and a request goes through the shell by id', async () => {
	await connectionKeys.set('c1', record.baseUrl, 'sk-secret');
	expect(JSON.parse(kept.get('c1') ?? '{}')).toEqual({
		endpoint: record.baseUrl,
		key: 'sk-secret',
	});
	expect(connectionKeys.keyOf(record)).toBeUndefined();
	const endpoint = connectionKeys.endpoint(record);
	await endpoint.fetch?.(`${record.baseUrl}/models`);
	expect(relayed.at(-1)).toEqual({
		connection: 'c1',
		url: `${record.baseUrl}/models`,
	});
	await connectionKeys.set('c1', '', null);
	expect(kept.has('c1')).toBe(false);
});

test('a key moves to a changed endpoint only from the one it was entered for', async () => {
	await connectionKeys.set('c1', 'https://a.test/v1', 'sk');
	await connectionKeys.move('c1', 'https://other.test/v1', 'https://b.test/v1');
	expect(JSON.parse(kept.get('c1') ?? '{}').endpoint).toBe('https://a.test/v1');
	await connectionKeys.move('c1', 'https://a.test/v1', 'https://b.test/v1');
	expect(JSON.parse(kept.get('c1') ?? '{}').endpoint).toBe('https://b.test/v1');
});
