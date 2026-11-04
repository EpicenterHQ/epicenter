/**
 * The desktop's `customEndpoints()` (`device-settings.tauri.ts`): the
 * connections it opens in the app's AppData root and the keychain, over a
 * real directory standing in for AppData and a stand-in shell.
 *
 * Key behaviors:
 * - The list is `connections.md` at the top of AppData, with no key in it;
 *   the key is in the keychain under the connection's id
 * - The connection's endpoint is merged at once and sends through the shell
 *   by its id, with no key from the page
 * - The model chosen for each job is `models.md` beside it, read back by
 *   the next page
 */
import { afterAll, expect, mock, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Contract } from '@epicenter/definition/contract';
import { openDevice } from '@epicenter/folder/node';
import { Ok, unwrap } from 'wellcrafted/result';

const keychain = new Map<string, string>();
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
						.filter((name) => keychain.has(name))
						.map((name) => [name, keychain.get(name)]),
				);
			case 'keychain_set': {
				const value = args?.value as string | null;
				if (value === null) keychain.delete(args?.name as string);
				else keychain.set(args?.name as string, value);
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
					onEvent.onmessage({
						kind: 'head',
						status: 200,
						headers: [['content-type', 'application/json']],
					});
					onEvent.onmessage([
						...new TextEncoder().encode(JSON.stringify({ data: [] })),
					]);
					onEvent.onmessage({ kind: 'end' });
				});
				return null;
			}
			default:
				throw new Error(`Unexpected command ${command}`);
		}
	},
}));

/** AppData, a real directory. */
const appData = await mkdtemp(join(tmpdir(), 'ai-appdata-'));
afterAll(() => rm(appData, { recursive: true, force: true }));
mock.module('@epicenter/folder/tauri', () => ({
	openDevice: async (contract: Contract, { root }: { root: string }) => {
		expect(root).toBe('AppData');
		return Ok(unwrap(await openDevice(contract, { path: appData })));
	},
}));

const { customEndpoints, modelChoices } = await import(
	'./device-settings.tauri.js'
);

test('a connection is listed in AppData with no key, its key is in the keychain, and its endpoint sends through the shell by its id', async () => {
	const connections = customEndpoints();
	await connections.ready;
	expect(connections.problem()).toBeNull();
	const id = await connections.add({
		name: 'Speaches',
		baseUrl: 'http://localhost:9000/v1',
		apiKey: 'sk-secret',
		models: ['whisper-1'],
	});
	const note = await readFile(join(appData, 'connections.md'), 'utf8');
	expect(note).toContain('http://localhost:9000/v1');
	expect(note).not.toContain('sk-secret');
	expect(JSON.parse(keychain.get(id) ?? 'null')).toEqual({
		endpoint: 'http://localhost:9000/v1',
		key: 'sk-secret',
	});
	expect(connections.list()).toEqual([
		{
			id,
			name: 'Speaches',
			baseUrl: 'http://localhost:9000/v1',
			models: ['whisper-1'],
			hasApiKey: true,
		},
	]);

	const [endpoint] = connections.endpoints();
	expect(endpoint?.id).toBe(id);
	expect((await endpoint!.fetch('models')).ok).toBe(true);
	expect(relayed).toEqual([
		{ connection: id, url: 'http://localhost:9000/v1/models' },
	]);
	await connections.remove(id);
	expect(keychain.has(id)).toBe(false);
	await connections.close();
});

test('the model chosen for each job is models.md in AppData, beside the connections, and the next page reads it back', async () => {
	const choices = modelChoices<'chat' | 'transcribe'>({
		chat: { endpoint: 'hosted', model: 'default' },
	});
	await choices.ready;
	expect(choices.get('chat')).toEqual({ endpoint: 'hosted', model: 'default' });
	await choices.set('transcribe', { endpoint: 'local-speech', model: 'base' });
	await choices.set('chat', { endpoint: 'ollama', model: 'llama3' });
	const note = await readFile(join(appData, 'models.md'), 'utf8');
	expect(note).toContain('local-speech');
	expect(note).toContain('llama3');

	const next = modelChoices<'chat' | 'transcribe'>();
	await next.ready;
	expect(next.get('chat')).toEqual({ endpoint: 'ollama', model: 'llama3' });
	expect(next.get('transcribe')).toEqual({
		endpoint: 'local-speech',
		model: 'base',
	});
	choices[Symbol.dispose]();
	next[Symbol.dispose]();
});
