import {
	parseAiConnections,
	validateAiConnectionRecords,
} from '@epicenter/app/ai-connections';
import { nanoid } from 'nanoid';
import {
	parseInferenceSelections,
	validateInferenceSelections,
} from './inference-selections.js';

function invalid(): never {
	throw new Error('Invalid persisted AI settings migration source.');
}
function parse(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return invalid();
	}
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
	return value as Record<string, unknown>;
}

/**
 * Split saved AI settings before exposing either owner. The exclusive Web Lock
 * makes every document use the same committed legacy ID mapping. Old bytes stay
 * untouched, and successful destination writes win when a failed attempt restarts.
 */
export async function migrateAiSettings({
	storage,
	storageKey,
	locks,
}: {
	storage: Pick<Storage, 'getItem' | 'setItem'>;
	storageKey: string;
	locks: Pick<LockManager, 'request'>;
}) {
	await locks.request(`${storageKey}.app-ai-migration`, () => {
		// Read inside the lock: another document may have completed normalization.
		const connectionsKey = `${storageKey}.app-ai-connections`;
		const selectionsKey = `${storageKey}.app-ai-selections`;
		const connectionsRaw = storage.getItem(connectionsKey);
		const selectionsRaw = storage.getItem(selectionsKey);
		if (connectionsRaw !== null) parseAiConnections(connectionsRaw);
		if (selectionsRaw !== null) parseInferenceSelections(selectionsRaw);
		if (connectionsRaw !== null && selectionsRaw !== null) return;

		const normalizedKey = `${storageKey}.app-ai`;
		let normalizedRaw = storage.getItem(normalizedKey);
		if (normalizedRaw === null) {
			const oldConnections = storage.getItem(
				`${storageKey}.inference-connections`,
			);
			const oldTargets = storage.getItem(`${storageKey}.inference-targets`);
			if (oldConnections !== null || oldTargets !== null) {
				const entries = oldConnections === null ? [] : parse(oldConnections);
				if (!Array.isArray(entries)) invalid();
				const connections = validateAiConnectionRecords(
					entries.map((value: unknown) => {
						const entry = object(value);
						if (
							Object.keys(entry).some(
								(key) => !['baseUrl', 'apiKey', 'models'].includes(key),
							) ||
							typeof entry.baseUrl !== 'string'
						)
							invalid();
						let name = 'Connection';
						try {
							name = new URL(entry.baseUrl).host;
						} catch {
							/* Keep the legacy display fallback. */
						}
						return {
							...entry,
							id: nanoid(),
							name,
							models: entry.models === undefined ? [] : entry.models,
						};
					}),
				);
				const selections = validateInferenceSelections(
					oldTargets === null ? {} : parse(oldTargets),
				);
				for (const target of Object.values(selections)) {
					const matches = connections.filter(
						({ baseUrl }) => baseUrl === target.connectionId,
					);
					target.connectionId =
						target.connectionId !== 'hosted' && matches.length === 1
							? matches[0]!.id
							: `unresolved:${target.connectionId}`;
				}
				storage.setItem(
					normalizedKey,
					JSON.stringify({ version: 1, connections, selections }),
				);
				// Copy only the committed mapping, never an uncommitted generated ID.
				normalizedRaw = storage.getItem(normalizedKey);
				if (normalizedRaw === null) invalid();
			}
		}
		const source =
			normalizedRaw === null
				? { version: 1, connections: [], selections: {} }
				: object(parse(normalizedRaw));
		if (
			source.version !== 1 ||
			Object.keys(source).some(
				(key) => !['version', 'connections', 'selections'].includes(key),
			)
		)
			invalid();
		const connections = validateAiConnectionRecords(source.connections);
		const selections = validateInferenceSelections(source.selections);
		// Both sources and both existing destinations were validated before any split write.
		if (connectionsRaw === null)
			storage.setItem(
				connectionsKey,
				JSON.stringify({ version: 1, connections }),
			);
		if (selectionsRaw === null)
			storage.setItem(
				selectionsKey,
				JSON.stringify({ version: 1, selections }),
			);
	});
}

/** Browser/WebView composition boundary; importing this module opens no resources. */
export async function initializeBrowserAiSettings(storageKey: string) {
	if (!navigator.locks)
		throw new Error('AI settings initialization requires Web Locks.');
	await migrateAiSettings({
		storage: window.localStorage,
		storageKey,
		locks: navigator.locks,
	});
}
