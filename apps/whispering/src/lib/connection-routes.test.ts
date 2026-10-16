/**
 * Route tests.
 * Verifies how each kind of connection routes a request when it is sent, and
 * how a result row's recorded connection is checked before it runs again:
 * a local row's model, an Epicenter row's account, and the refusals in the
 * words a person sees.
 */
import { expect, test } from 'bun:test';
import type { ConnectionKind, KeyState } from '@epicenter/ai/send';
import type { ConnectionFields } from '@epicenter/ai/ui';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import {
	type RoutePorts,
	recordedRoute,
	routeOf,
} from './connection-routes.js';

const ACCOUNT = 'https://api.epicenter.test/v1';

/** Ports over `rows`, by id, as a workspace and its `so.epicenter` answer. */
function ports({
	rows,
	kinds = ['openai-compatible', 'epicenter', 'local'],
	keys = {},
	account,
	activeModel = Ok('whisper-small'),
	local = true,
}: {
	rows: Record<string, Partial<ConnectionFields> & { kind: ConnectionKind }>;
	kinds?: readonly ConnectionKind[];
	keys?: Record<string, KeyState>;
	account?: string;
	activeModel?: Result<string, string>;
	local?: boolean;
}): RoutePorts {
	return {
		workspace: {
			connections: {
				kinds,
				keys: {
					place: 'computer',
					state: async (id) => Ok(keys[id] ?? { state: 'missing' }),
					save: async () => Ok(undefined),
					remove: async () => Ok(undefined),
				},
				epicenterNote: '',
				note: '',
				open: async () => Err('not used'),
				epicenterEndpoint: async () =>
					account === undefined ? Err('sign in first') : Ok(account),
				send: async () => Err({ message: 'not used' }),
			},
			localTranscription: local
				? {
						activeModel: async () => activeModel,
						transcribe: async () => Ok({ text: '' }),
					}
				: undefined,
		},
		rows: {
			async get(id) {
				const row = rows[id];
				if (row === undefined) return Ok(undefined);
				const fields = { title: id, model: '', ...row };
				return Ok({
					path: `connections/${id}.md`,
					sha256: '',
					text: '',
					row: { fields, body: '' },
				});
			},
		} as RoutePorts['rows'],
	};
}

test('a local connection uses the model it names, else the active one, and only transcribes', async () => {
	const named = ports({
		rows: { device: { kind: 'local', model: 'parakeet' } },
	});
	expect(expectOk(await routeOf(named, 'transcription', 'device'))).toEqual({
		connection: 'device',
		kind: 'local',
		title: 'device',
		model: 'parakeet',
		endpoint: '',
	});
	const active = ports({ rows: { device: { kind: 'local' } } });
	expect(expectOk(await routeOf(active, 'transcription', 'device')).model).toBe(
		'whisper-small',
	);
	const none = ports({
		rows: { device: { kind: 'local' } },
		activeModel: Err('No local model is active.'),
	});
	expect((await routeOf(none, 'transcription', 'device')).error).toBe(
		'No local model is active.',
	);
	expect((await routeOf(named, 'text', 'device')).error).toContain(
		'which only transcribes',
	);
	const browser = ports({
		rows: { device: { kind: 'local', model: 'parakeet' } },
		kinds: ['openai-compatible'],
		local: false,
	});
	expect((await routeOf(browser, 'transcription', 'device')).error).toContain(
		'which this browser does not have',
	);
});

test('an Epicenter connection sends to the account, and is refused signed out', async () => {
	const rows = { hosted: { kind: 'epicenter' as const, model: 'whisper-1' } };
	expect(
		expectOk(
			await routeOf(
				ports({ rows, account: ACCOUNT }),
				'transcription',
				'hosted',
			),
		),
	).toMatchObject({ kind: 'epicenter', endpoint: ACCOUNT, model: 'whisper-1' });
	expect(
		(await routeOf(ports({ rows }), 'transcription', 'hosted')).error,
	).toBe('hosted sends to your Epicenter account: sign in first');
});

test('an endpoint uses its saved endpoint, and a recipe’s own model before the row’s', async () => {
	const rows = { groq: { kind: 'openai-compatible' as const, model: 'llama' } };
	const saved = ports({
		rows,
		keys: {
			groq: { state: 'saved', endpoint: 'https://groq.test/v1', hasKey: true },
		},
	});
	expect(
		expectOk(await routeOf(saved, 'text', 'groq', 'mixtral')),
	).toMatchObject({
		endpoint: 'https://groq.test/v1',
		model: 'mixtral',
	});
	expect((await routeOf(ports({ rows }), 'text', 'groq')).error).toBe(
		'groq has no endpoint saved yet. Add one in Settings.',
	);
	expect(
		(
			await routeOf(
				ports({ rows: { groq: { kind: 'openai-compatible' } } }),
				'text',
				'groq',
			)
		).error,
	).toBe('groq names no model. Add one in Settings.');
	expect((await routeOf(saved, 'text', undefined)).error).toBe(
		'No text connection is chosen. Choose one in Settings.',
	);
	expect((await routeOf(saved, 'text', 'gone')).error).toBe(
		'The text connection is gone. Choose another in Settings.',
	);
});

test('running again keeps the recorded model and endpoint, and refuses a connection that changed under it', async () => {
	const recorded = { connection: 'device', endpoint: '', model: 'parakeet' };
	expect(
		expectOk(
			await recordedRoute(
				ports({ rows: { device: { kind: 'local', model: 'other' } } }),
				'transcription',
				recorded,
			),
		),
	).toMatchObject({ kind: 'local', model: 'parakeet', endpoint: '' });
	// A row that was an endpoint and is local now is not what this ran over.
	expect(
		(
			await recordedRoute(
				ports({ rows: { groq: { kind: 'local' } } }),
				'transcription',
				{
					connection: 'groq',
					endpoint: 'https://groq.test/v1',
					model: 'llama',
				},
			)
		).error,
	).toContain('no longer the kind of connection');
	// An account that now sends somewhere else is not where this went.
	const hosted = { hosted: { kind: 'epicenter' as const, model: 'whisper-1' } };
	const sent = { connection: 'hosted', endpoint: ACCOUNT, model: 'whisper-1' };
	expect(
		expectOk(
			await recordedRoute(
				ports({ rows: hosted, account: ACCOUNT }),
				'transcription',
				sent,
			),
		).endpoint,
	).toBe(ACCOUNT);
	expect(
		(
			await recordedRoute(
				ports({ rows: hosted, account: 'https://elsewhere.test/v1' }),
				'transcription',
				sent,
			)
		).error,
	).toContain(`This was run with ${ACCOUNT}`);
});
