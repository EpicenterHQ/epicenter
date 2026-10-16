/**
 * Import tests.
 * Verifies that an earlier build's connections and tutor choice become rows,
 * saved keys, and `tutorConnection` once, that a row deleted afterward stays
 * deleted, and that what does not read is skipped.
 */
import { expect, test } from 'bun:test';
import { createMemorySecrets, readKeyEntry } from '@epicenter/ai/send';
import { expectOk } from 'wellcrafted/testing';
import { VOCAB_MODEL } from './data.js';
import { createBrowser } from './folder.test-support.js';
import {
	EARLIER_CONNECTIONS,
	EARLIER_SELECTIONS,
	importEarlierConnections,
} from './import-connections.js';

function storageWith(values: Record<string, unknown>) {
	const text = new Map(
		Object.entries(values).map(([key, value]) => [
			key,
			typeof value === 'string' ? value : JSON.stringify(value),
		]),
	);
	return { getItem: (key: string) => text.get(key) ?? null };
}

const earlier = {
	version: 1,
	connections: [
		{
			id: 'groq1',
			name: 'Groq',
			baseUrl: 'https://api.groq.com/openai/v1/',
			apiKey: 'gsk-1',
			models: ['llama-a', 'llama-b'],
		},
		{
			id: '-odd_id',
			name: 'Local Ollama',
			baseUrl: 'http://localhost:11434/v1',
			models: [],
		},
		{ id: 'broken', name: 'Broken', baseUrl: 'not a url', models: [] },
	],
};

async function fields(
	connections: Awaited<
		ReturnType<ReturnType<typeof createBrowser>['openConnections']>
	>,
) {
	const listing = expectOk(await connections.tables.connections.list());
	return Object.fromEntries(
		listing.map(({ stem, result }) => [stem, expectOk(result).row.fields]),
	);
}

test('earlier connections become rows and saved keys, and the tutor keeps its choice', async () => {
	await using browser = createBrowser();
	const vocab = await browser.open();
	const connections = await browser.openConnections();
	const secrets = createMemorySecrets();
	await importEarlierConnections({
		vocab,
		connections,
		secrets,
		storage: storageWith({
			[EARLIER_CONNECTIONS]: earlier,
			[EARLIER_SELECTIONS]: {
				version: 1,
				selections: { tutor: { connectionId: 'groq1', model: 'llama-b' } },
			},
		}),
	});

	expect(await fields(connections)).toEqual({
		groq1: { kind: 'openai-compatible', title: 'Groq', model: 'llama-b' },
		'local-ollama': {
			kind: 'openai-compatible',
			title: 'Local Ollama',
			model: '',
		},
	});
	expect(expectOk(await readKeyEntry(secrets, 'groq1'))).toEqual({
		endpoint: 'https://api.groq.com/openai/v1',
		key: 'gsk-1',
	});
	expect(expectOk(await readKeyEntry(secrets, 'local-ollama'))).toEqual({
		endpoint: 'http://localhost:11434/v1',
		key: '',
	});
	expect(expectOk(await vocab.kv.get())?.values).toEqual({
		tutorConnection: 'groq1',
		connectionsImported: true,
	});
});

test('the import runs once, so a row deleted afterward stays deleted', async () => {
	await using browser = createBrowser();
	const vocab = await browser.open();
	const connections = await browser.openConnections();
	const secrets = createMemorySecrets();
	const storage = storageWith({ [EARLIER_CONNECTIONS]: earlier });
	await importEarlierConnections({ vocab, connections, secrets, storage });
	expectOk(await connections.tables.connections.delete('groq1'));

	await importEarlierConnections({ vocab, connections, secrets, storage });
	expect(Object.keys(await fields(connections))).toEqual(['local-ollama']);
});

test('the hosted default is no row; another hosted model becomes an Epicenter row', async () => {
	await using browser = createBrowser();
	const vocab = await browser.open();
	const connections = await browser.openConnections();
	await importEarlierConnections({
		vocab,
		connections,
		secrets: createMemorySecrets(),
		storage: storageWith({
			[EARLIER_SELECTIONS]: {
				version: 1,
				selections: {
					tutor: { connectionId: 'account:["a","b"]', model: VOCAB_MODEL },
				},
			},
		}),
	});
	expect(await fields(connections)).toEqual({});
	expect(
		expectOk(await vocab.kv.get())?.values.tutorConnection,
	).toBeUndefined();

	await using other = createBrowser();
	const otherVocab = await other.open();
	const otherConnections = await other.openConnections();
	await importEarlierConnections({
		vocab: otherVocab,
		connections: otherConnections,
		secrets: createMemorySecrets(),
		storage: storageWith({
			[EARLIER_SELECTIONS]: {
				version: 1,
				selections: {
					tutor: { connectionId: 'account:["a","b"]', model: 'other-model' },
				},
			},
		}),
	});
	expect(await fields(otherConnections)).toEqual({
		epicenter: { kind: 'epicenter', title: 'Epicenter', model: 'other-model' },
	});
	expect(expectOk(await otherVocab.kv.get())?.values.tutorConnection).toBe(
		'epicenter',
	);
});

test('storage that does not read imports nothing and is left as it is', async () => {
	await using browser = createBrowser();
	const vocab = await browser.open();
	const connections = await browser.openConnections();
	await importEarlierConnections({
		vocab,
		connections,
		secrets: createMemorySecrets(),
		storage: storageWith({
			[EARLIER_CONNECTIONS]: '{ not json',
			[EARLIER_SELECTIONS]: '[]',
		}),
	});
	expect(await fields(connections)).toEqual({});
	expect(expectOk(await vocab.kv.get())?.values).toEqual({
		connectionsImported: true,
	});
});

test('an import run again before it finished writes the same rows, not copies', async () => {
	await using browser = createBrowser();
	const vocab = await browser.open();
	const connections = await browser.openConnections();
	const secrets = createMemorySecrets();
	const storage = storageWith({ [EARLIER_CONNECTIONS]: earlier });
	await importEarlierConnections({ vocab, connections, secrets, storage });
	// As if the first run stopped before it could record that it ran.
	expectOk(await vocab.kv.set('connectionsImported', undefined));
	await importEarlierConnections({ vocab, connections, secrets, storage });
	expect(Object.keys(await fields(connections)).sort()).toEqual([
		'groq1',
		'local-ollama',
	]);
});
