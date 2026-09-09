import { nanoid } from 'nanoid';

export type AiConnectionConfiguration = {
	id: string;
	name: string;
	baseUrl: string;
	apiKey?: string;
	models: string[];
};

export type AiTarget = { connectionId: string; model: string };

type Envelope = {
	version: 1;
	connections: AiConnectionConfiguration[];
	selections: Record<string, AiTarget>;
};

function invalid(): never {
	throw new Error('Invalid persisted App AI configuration.');
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
	return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[]) {
	if (Object.keys(value).some((key) => !allowed.includes(key))) invalid();
}

function string(value: unknown): string {
	if (typeof value !== 'string') invalid();
	return value;
}

function parse(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return invalid();
	}
}

function defaultName(baseUrl: string) {
 try { return new URL(baseUrl).host; } catch { return 'Connection'; }
}

function connection(value: unknown, legacy = false): AiConnectionConfiguration {
	const entry = object(value);
	keys(
		entry,
		legacy
			? ['baseUrl', 'apiKey', 'models']
			: ['id', 'name', 'baseUrl', 'apiKey', 'models'],
	);
	const baseUrl = string(entry.baseUrl);
	const models = legacy && entry.models === undefined ? [] : entry.models;
	if (!Array.isArray(models)) invalid();
	const id = legacy ? nanoid() : string(entry.id);
	if (!id || id.startsWith('unresolved:')) invalid();
	return {
		id,
		name: legacy ? defaultName(baseUrl) : string(entry.name),
		baseUrl,
		...(entry.apiKey === undefined ? {} : { apiKey: string(entry.apiKey) }),
		models: models.map(string),
	};
}

function selections(value: unknown): Record<string, AiTarget> {
	return Object.fromEntries(
		Object.entries(object(value)).map(([scope, value]) => {
			const entry = object(value);
			keys(entry, ['connectionId', 'model']);
			return [
				scope,
				{
					connectionId: string(entry.connectionId),
					model: string(entry.model),
				},
			];
		}),
	);
}

function envelope(value: unknown): Envelope {
	const entry = object(value);
	keys(entry, ['version', 'connections', 'selections']);
	if (entry.version !== 1 || !Array.isArray(entry.connections)) invalid();
	const connections = entry.connections.map((entry) => connection(entry));
	if (new Set(connections.map(({ id }) => id)).size !== connections.length)
		invalid();
	return { version: 1, connections, selections: selections(entry.selections) };
}

/** Owns device-local AI settings and saved destinations for one open App. */
export function createAiConfiguration({
	storage,
	storageKey,
	subscribeStorage,
}: {
	storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
	storageKey: string;
	subscribeStorage?: (listener: () => void) => () => void;
}) {
	const key = `${storageKey}.app-ai`;
	let closed = false;
	const listeners = new Set<() => void>();
	let state = load();

	function load(): Envelope {
		const raw = storage.getItem(key);
		if (raw !== null) return envelope(parse(raw));
		const oldConnections = storage.getItem(
			`${storageKey}.inference-connections`,
		);
		const oldTargets = storage.getItem(`${storageKey}.inference-targets`);
		if (oldConnections === null && oldTargets === null) {
			return { version: 1, connections: [], selections: {} };
		}
		const oldEntries = oldConnections === null ? [] : parse(oldConnections);
		if (!Array.isArray(oldEntries)) invalid();
		const connections = oldEntries.map((entry) => connection(entry, true));
		const targets = oldTargets === null ? {} : selections(parse(oldTargets));
		for (const target of Object.values(targets)) {
			const matches = connections.filter(
				({ baseUrl }) => baseUrl === target.connectionId,
			);
			target.connectionId =
				target.connectionId !== 'hosted' && matches.length === 1
					? matches[0]!.id
					: `unresolved:${target.connectionId}`;
		}
		const imported: Envelope = { version: 1, connections, selections: targets };
		// Commit the entire import before publishing it; retain legacy keys for recovery.
		storage.setItem(key, JSON.stringify(imported));
		return imported;
	}

	function assertOpen() {
		if (closed) throw new Error('App AI configuration is closed.');
	}

	function notify() {
		for (const listener of listeners) listener();
	}

	function commit(next: Envelope) {
		assertOpen();
		const validated = envelope(next);
		storage.setItem(key, JSON.stringify(validated));
		state = validated;
		notify();
	}

	const unsubscribe = subscribeStorage?.(() => {
		if (closed) return;
		const raw = storage.getItem(key);
		// Legacy import runs only on opening, never after an external deletion.
		const next =
			raw === null
				? { version: 1 as const, connections: [], selections: {} }
				: envelope(parse(raw));
		if (JSON.stringify(next) === JSON.stringify(state)) return;
		state = next;
		notify();
	});

	return {
		/** Management snapshot, including explicit credentials; never sync or log it. */
		read(): readonly AiConnectionConfiguration[] {
			assertOpen();
			return structuredClone(state.connections);
		},
		onChange(listener: () => void) {
			assertOpen();
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		add(input: {
			name?: string;
			baseUrl: string;
			apiKey?: string;
			models?: string[];
		}) {
			assertOpen();
			const id = nanoid();
			commit({
				...state,
				connections: [
					...state.connections,
					{ ...input, name: input.name ?? defaultName(input.baseUrl), id, models: input.models ?? [] },
				],
			});
			return id;
		},
		update(id: string, patch: Partial<Omit<AiConnectionConfiguration, 'id'>>) {
			assertOpen();
			if (!state.connections.some((entry) => entry.id === id))
				throw new Error('AI connection does not exist.');
			commit({
				...state,
				connections: state.connections.map((entry) =>
					entry.id === id ? { ...entry, ...patch, id } : entry,
				),
			});
		},
		remove(id: string) {
			commit({
				...state,
				connections: state.connections.filter((entry) => entry.id !== id),
			});
		},
		reorder(ids: readonly string[]) {
			assertOpen();
			const entries = new Map(
				state.connections.map((entry) => [entry.id, entry]),
			);
			if (
				ids.length !== entries.size ||
				new Set(ids).size !== ids.length ||
				ids.some((id) => !entries.has(id))
			) {
				throw new Error(
					'AI connection order must contain each existing id once.',
				);
			}
			commit({ ...state, connections: ids.map((id) => entries.get(id)!) });
		},
		select(scope: string, target: AiTarget) {
			commit({
				...state,
				selections: { ...state.selections, [scope]: target },
			});
		},
		target(scope: string, model: string): AiTarget | null {
			assertOpen();
			const selected = Object.hasOwn(state.selections, scope)
				? state.selections[scope]
				: undefined;
			return selected?.model === model ? { ...selected } : null;
		},
		close() {
			if (closed) return;
			closed = true;
			listeners.clear();
			unsubscribe?.();
		},
	};
}

export type AiConfiguration = ReturnType<typeof createAiConfiguration>;
