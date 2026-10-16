/**
 * The connections and tutor choice an earlier build kept in this browser's
 * storage become rows of `so.epicenter`, saved keys, and `tutorConnection`
 * (ADR-0581). It runs until it has run once, which `connectionsImported` in
 * Vocab's folder records, so a row deleted afterward stays deleted. The old
 * entries are left where they are, and an entry that does not read is
 * skipped (ADR-0503).
 */

import {
	connectionId,
	type epicenterDefinition,
} from '@epicenter/ai/connection-table';
import {
	canonicalEndpoint,
	isConnectionId,
	readKeyEntry,
	type SecretStore,
	saveKey,
} from '@epicenter/ai/send';
import type { Folder } from '@epicenter/folder';
import { VOCAB_MODEL, type VocabFolder } from './data.js';

/** Where the earlier build kept its connections and Vocab's chosen model. */
export const EARLIER_CONNECTIONS = 'epicenter/ai/no-account.app-ai-connections';
export const EARLIER_SELECTIONS = 'vocab/no-account.app-ai-selections';

type EarlierConnection = {
	id: string;
	name: string;
	baseUrl: string;
	apiKey?: string;
	models: string[];
};

function readJson(storage: Pick<Storage, 'getItem'>, key: string): unknown {
	const text = storage.getItem(key);
	if (text === null) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function earlierConnections(value: unknown): EarlierConnection[] {
	const list = (value as { connections?: unknown } | undefined)?.connections;
	if (!Array.isArray(list)) return [];
	return list.filter(
		(entry): entry is EarlierConnection =>
			typeof entry?.id === 'string' &&
			typeof entry.name === 'string' &&
			typeof entry.baseUrl === 'string' &&
			(entry.apiKey === undefined || typeof entry.apiKey === 'string') &&
			Array.isArray(entry.models) &&
			entry.models.every((model: unknown) => typeof model === 'string'),
	);
}

function earlierTutor(value: unknown) {
	const tutor = (value as { selections?: { tutor?: unknown } } | undefined)
		?.selections?.tutor as
		| { connectionId?: unknown; model?: unknown }
		| undefined;
	return typeof tutor?.connectionId === 'string' &&
		typeof tutor.model === 'string'
		? { connectionId: tutor.connectionId, model: tutor.model }
		: undefined;
}

/**
 * Bring an earlier build's connections into `connections` and `secrets`,
 * and its tutor choice into `vocab`'s settings, once. Each connection
 * becomes one row naming the model the tutor used on it, or its first saved
 * model. A choice of the hosted account with a model other than
 * `VOCAB_MODEL` becomes an `epicenter` row.
 */
export async function importEarlierConnections({
	vocab,
	connections,
	secrets,
	storage = globalThis.localStorage,
}: {
	vocab: Pick<VocabFolder, 'kv'>;
	connections: Pick<Folder<typeof epicenterDefinition>, 'tables'>;
	secrets: SecretStore;
	storage?: Pick<Storage, 'getItem'>;
}) {
	const { data: settings } = await vocab.kv.get();
	if (settings?.values.connectionsImported) return;

	const tutor = earlierTutor(readJson(storage, EARLIER_SELECTIONS));
	const rows = connections.tables.connections;
	const { data: listing } = await rows.list();
	const taken = new Set((listing ?? []).map(({ stem }) => stem));
	let tutorConnection: string | undefined;

	for (const earlier of earlierConnections(
		readJson(storage, EARLIER_CONNECTIONS),
	)) {
		const { data: endpoint, error } = canonicalEndpoint(earlier.baseUrl);
		if (error !== null) continue;
		const stem =
			isConnectionId(earlier.id) && !taken.has(earlier.id)
				? earlier.id
				: connectionId(earlier.name, taken);
		taken.add(stem);
		const chosen = tutor?.connectionId === earlier.id ? tutor.model : undefined;
		const created = await rows.create(
			{
				fields: {
					kind: 'openai-compatible',
					title: earlier.name,
					model: chosen ?? earlier.models[0] ?? '',
				},
				body: '',
			},
			{ stem },
		);
		if (created.error !== null) continue;
		const { data: saved } = await readKeyEntry(secrets, stem);
		if (saved === undefined)
			await saveKey(secrets, stem, { endpoint, key: earlier.apiKey ?? '' });
		if (chosen !== undefined) tutorConnection = stem;
	}

	if (
		tutor?.connectionId.startsWith('account:') &&
		tutor.model &&
		tutor.model !== VOCAB_MODEL
	) {
		const stem = connectionId('Epicenter', taken);
		const created = await rows.create(
			{
				fields: { kind: 'epicenter', title: 'Epicenter', model: tutor.model },
				body: '',
			},
			{ stem },
		);
		if (created.error === null) tutorConnection = stem;
	}

	if (tutorConnection !== undefined)
		await vocab.kv.set('tutorConnection', tutorConnection);
	await vocab.kv.set('connectionsImported', true);
}
