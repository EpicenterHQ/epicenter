/**
 * Tutor route tests.
 * Verifies the hosted default with and without a sign-in, that a chosen row
 * routes by its kind to its saved endpoint, and that every missing piece is
 * an error a learner can act on rather than a turn sent somewhere else.
 */
import { expect, test } from 'bun:test';
import { createMemorySecrets, saveKey } from '@epicenter/ai/send';
import { expectOk } from 'wellcrafted/testing';
import { VOCAB_MODEL } from './data.js';
import { createBrowser } from './folder.test-support.js';
import { tutorRoute } from './tutor.js';

const account = {
	baseURL: 'https://api.epicenter.test/',
	fetch: async () => new Response('{}'),
};

async function withRows(
	rows: Record<
		string,
		{
			kind: 'openai-compatible' | 'epicenter' | 'local';
			title: string;
			model: string;
		}
	>,
) {
	const browser = createBrowser();
	const connections = await browser.openConnections();
	for (const [stem, fields] of Object.entries(rows))
		expectOk(
			await connections.tables.connections.create(
				{ fields, body: '' },
				{ stem },
			),
		);
	return { browser, connections };
}

test('with nothing chosen, a signed-in learner gets the hosted model and a signed-out one is told what to do', async () => {
	const hosted = expectOk(
		await tutorRoute({
			choice: undefined,
			connections: null,
			account,
			secrets: createMemorySecrets(),
		}),
	);
	expect(hosted.model).toBe(VOCAB_MODEL);
	expect(hosted.client.baseURL).toBe('https://api.epicenter.test/v1');

	const signedOut = await tutorRoute({
		choice: undefined,
		connections: null,
		account: undefined,
		secrets: createMemorySecrets(),
	});
	expect(signedOut.error).toContain('Choose a connection');
});

test('a chosen endpoint routes to the endpoint saved for it, with its model', async () => {
	const { browser, connections } = await withRows({
		groq: { kind: 'openai-compatible', title: 'Groq', model: 'llama' },
	});
	await using _ = browser;
	const secrets = createMemorySecrets();
	const missing = await tutorRoute({
		choice: 'groq',
		connections,
		account: undefined,
		secrets,
	});
	expect(missing.error).toBe(
		'Groq has no endpoint saved in this browser. Add one in Connections.',
	);

	await saveKey(secrets, 'groq', {
		endpoint: 'https://api.groq.test/v1',
		key: 'gsk',
	});
	const route = expectOk(
		await tutorRoute({
			choice: 'groq',
			connections,
			account: undefined,
			secrets,
		}),
	);
	expect(route.client.baseURL).toBe('https://api.groq.test/v1');
	expect(route.model).toBe('llama');
});

test('a gone row, a row with no model, an Epicenter row signed out, and a local row are refused', async () => {
	const { browser, connections } = await withRows({
		bare: { kind: 'openai-compatible', title: 'Bare', model: '' },
		hosted: { kind: 'epicenter', title: 'Hosted', model: 'other' },
		device: { kind: 'local', title: 'Device', model: '' },
	});
	await using _ = browser;
	const secrets = createMemorySecrets();
	const route = (choice: string, signedIn = false) =>
		tutorRoute({
			choice,
			connections,
			account: signedIn ? account : undefined,
			secrets,
		});

	expect((await route('gone')).error).toBe(
		'The connection the tutor used is gone. Choose another.',
	);
	expect((await route('bare')).error).toBe(
		'Bare names no model. Add one in Connections.',
	);
	expect((await route('hosted')).error).toBe(
		'Hosted sends to your Epicenter account. Sign in to use it.',
	);
	expect(expectOk(await route('hosted', true)).model).toBe('other');
	expect((await route('device')).error).toContain('a browser does not have');
});
