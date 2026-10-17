/**
 * This machine's AI connections (ADR-0587): `connections.json` in app data,
 * written only by the CLI, and each key in a keychain store held in memory.
 *
 * Key behaviors:
 * - Setting a connection writes its entry, then its key, so a keychain that
 *   fails leaves an entry the listing shows as "key missing", never a key
 *   with no entry.
 * - Removing one deletes its key, then its entry, so a keychain that fails
 *   keeps the entry and its key.
 * - The listing names every entry with its endpoint and whether its key is
 *   saved, never the key; a kind with no key lists none.
 * - An app's choice of connection is kept under its id and dropped with the
 *   connection it names.
 * - A file that does not read is refused and left as it is.
 *
 * See also:
 * - `ai-commands.test.ts` for the same commands through the binary.
 */
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemorySecrets, type SecretStore } from '@epicenter/ai/send';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	listConnections,
	removeConnection,
	setConnection,
	useConnection,
} from './connections.ts';

const KEY = 'sk-secret-0123';
const WHISPERING = 'so.epicenter.whispering';

/** Scratch app data and cache directories. */
async function setup() {
	const dir = await mkdtemp(join(tmpdir(), 'epicenter-connections-'));
	const paths = { dataDir: join(dir, 'data'), cacheDir: join(dir, 'cache') };
	const file = join(paths.dataDir, 'connections.json');
	return {
		paths,
		file,
		read: async () => JSON.parse(await readFile(file, 'utf8')),
	};
}

/** A store whose `set` or `delete` fails as an unreachable keychain does. */
function failing(
	method: 'set' | 'delete',
	inner: SecretStore = createMemorySecrets(),
): SecretStore {
	return {
		...inner,
		[method]: async () => {
			throw new Error('the keychain is locked');
		},
	};
}

test('set writes the entry and the key; the listing names the endpoint and never the key', async () => {
	const { paths, read } = await setup();
	const secrets = createMemorySecrets();
	const groq = expectOk(
		await setConnection(paths, secrets, 'groq', {
			kind: 'openai-compatible',
			title: ' Groq ',
			model: 'whisper-large-v3',
			endpoint: 'https://API.groq.com/openai/v1/',
			key: KEY,
		}),
	);
	expect(groq).toEqual({
		id: 'groq',
		kind: 'openai-compatible',
		title: 'Groq',
		model: 'whisper-large-v3',
		key: {
			state: 'saved',
			endpoint: 'https://api.groq.com/openai/v1',
			hasKey: true,
		},
	});
	expect(await read()).toEqual({
		connections: {
			groq: {
				kind: 'openai-compatible',
				title: 'Groq',
				model: 'whisper-large-v3',
			},
		},
		apps: {},
	});
	expect(JSON.stringify(await read())).not.toContain('api.groq.com');

	// A title alone changes the entry and leaves the key where it is.
	expectOk(await setConnection(paths, secrets, 'groq', { title: 'Groq fast' }));
	const listing = expectOk(await listConnections(paths, secrets));
	expect(listing.connections).toEqual([{ ...groq, title: 'Groq fast' }]);
	expect(JSON.stringify(listing)).not.toContain(KEY);
});

test('a connection whose keychain entry is gone lists as key missing; a kind with no key lists none', async () => {
	const { paths, file } = await setup();
	await mkdir(paths.dataDir, { recursive: true });
	await writeFile(
		file,
		JSON.stringify({
			connections: {
				account: {
					kind: 'epicenter',
					title: 'Epicenter',
					model: 'gpt-4o-mini',
				},
				groq: { kind: 'openai-compatible', title: 'Groq', model: 'm' },
				broken: { kind: 'openai-compatible', title: 'Broken', model: 'm' },
			},
		}),
	);
	const secrets = createMemorySecrets();
	await secrets.set('broken', 'not json');
	const { connections } = expectOk(await listConnections(paths, secrets));
	expect(connections.map(({ id, key }) => [id, key])).toEqual([
		['account', null],
		[
			'broken',
			{
				state: 'unreadable',
				message:
					"The keychain entry for 'broken' does not read. Save its endpoint and key again.",
			},
		],
		['groq', { state: 'missing' }],
	]);
});

test('set writes the entry before the key: a keychain that fails leaves the entry with its key missing', async () => {
	const { paths } = await setup();
	const refused = expectErr(
		await setConnection(paths, failing('set'), 'groq', {
			kind: 'openai-compatible',
			title: 'Groq',
			model: 'm',
			endpoint: 'https://api.groq.com/openai/v1',
			key: KEY,
		}),
	);
	expect(refused.name).toBe('KeychainUnavailable');
	const { connections } = expectOk(
		await listConnections(paths, createMemorySecrets()),
	);
	expect(connections).toEqual([
		{
			id: 'groq',
			kind: 'openai-compatible',
			title: 'Groq',
			model: 'm',
			key: { state: 'missing' },
		},
	]);
});

test('remove deletes the key before the entry: a keychain that fails keeps both', async () => {
	const { paths } = await setup();
	const secrets = createMemorySecrets();
	await setConnection(paths, secrets, 'groq', {
		kind: 'openai-compatible',
		title: 'Groq',
		model: 'm',
		endpoint: 'https://api.groq.com/openai/v1',
		key: KEY,
	});
	expect(
		expectErr(await removeConnection(paths, failing('delete', secrets), 'groq'))
			.name,
	).toBe('KeychainUnavailable');
	const { connections } = expectOk(await listConnections(paths, secrets));
	expect(connections[0]?.key).toMatchObject({ state: 'saved', hasKey: true });

	expect(expectOk(await removeConnection(paths, secrets, 'groq'))).toEqual({
		removed: true,
	});
	expect(await secrets.get('groq')).toBeNull();
	expect(expectOk(await listConnections(paths, secrets)).connections).toEqual(
		[],
	);
	expect(expectOk(await removeConnection(paths, secrets, 'groq'))).toEqual({
		removed: false,
	});
});

test('set refuses what it cannot keep, and writes nothing', async () => {
	const { paths, file } = await setup();
	const secrets = createMemorySecrets();
	const refusals = [
		await setConnection(paths, secrets, 'groq', { title: 'No kind' }),
		await setConnection(paths, secrets, 'groq', {
			kind: 'openai-compatible',
			endpoint: 'ftp://example.com',
		}),
		await setConnection(paths, secrets, 'account', {
			kind: 'epicenter',
			endpoint: 'https://api.example.com/v1',
			key: KEY,
		}),
		await setConnection(paths, secrets, 'groq', {
			kind: 'openai-compatible',
			key: KEY,
		}),
		await setConnection(paths, secrets, 'groq', {
			kind: 'openai-compatible',
			url: 'https://api.example.com/v1',
		}),
		await setConnection(paths, secrets, '../groq', { kind: 'local' }),
	];
	for (const result of refusals) expectErr(result);
	expect(await Bun.file(file).exists()).toBe(false);

	await setConnection(paths, secrets, 'account', { kind: 'epicenter' });
	expect(
		expectErr(
			await setConnection(paths, secrets, 'account', {
				kind: 'openai-compatible',
			}),
		).message,
	).toContain('Remove it and add it again');
});

test("an app's choice is kept under its id and dropped with the connection it names", async () => {
	const { paths, read } = await setup();
	const secrets = createMemorySecrets();
	expectErr(
		await useConnection(paths, {
			id: 'groq',
			app: WHISPERING,
			operation: 'transcription',
		}),
	);
	await setConnection(paths, secrets, 'groq', { kind: 'openai-compatible' });
	await setConnection(paths, secrets, 'account', { kind: 'epicenter' });
	expectOk(
		await useConnection(paths, {
			id: 'groq',
			app: WHISPERING,
			operation: 'transcription',
		}),
	);
	expectOk(
		await useConnection(paths, {
			id: 'account',
			app: WHISPERING,
			operation: 'text',
		}),
	);
	expect((await read()).apps).toEqual({
		[WHISPERING]: { transcription: 'groq', text: 'account' },
	});
	expectErr(
		await useConnection(paths, {
			id: 'groq',
			app: 'Whispering',
			operation: 'text',
		}),
	);

	await removeConnection(paths, secrets, 'groq');
	expect(expectOk(await listConnections(paths, secrets)).apps).toEqual({
		[WHISPERING]: { text: 'account' },
	});
});

test('a file that does not read is refused and never overwritten', async () => {
	const { paths, file } = await setup();
	const secrets = createMemorySecrets();
	await setConnection(paths, secrets, 'groq', { kind: 'openai-compatible' });
	for (const text of [
		'{ "connections": ',
		'{ "connections": { "groq": { "kind": "openai-compatible", "title": "Groq", "model": "m", "endpoint": "https://elsewhere" } } }',
		'{ "connections": { "groq": { "kind": "smtp", "title": "Groq", "model": "m" } } }',
		'{ "connection": {} }',
	]) {
		await writeFile(file, text);
		expect(expectErr(await listConnections(paths, secrets)).name).toBe(
			'Unreadable',
		);
		expectErr(await setConnection(paths, secrets, 'other', { kind: 'local' }));
		expectErr(await removeConnection(paths, secrets, 'groq'));
		expect(await readFile(file, 'utf8')).toBe(text);
	}
});
