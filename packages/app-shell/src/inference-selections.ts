import type { AppAi } from '@epicenter/app/ai';

export type InferenceTarget = { connectionId: string; model: string };

function invalid(): never {
	throw new Error('Invalid persisted inference selections.');
}

/** Validate application-owned choices while retaining unavailable references. */
export function validateInferenceSelections(
	value: unknown,
): Record<string, InferenceTarget> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
	return Object.fromEntries(
		Object.entries(value).map(([scope, value]: [string, unknown]) => {
			if (!value || typeof value !== 'object' || Array.isArray(value))
				invalid();
			const entry = value as Record<string, unknown>;
			if (
				Object.keys(entry).some(
					(key) => !['connectionId', 'model'].includes(key),
				) ||
				typeof entry.connectionId !== 'string' ||
				typeof entry.model !== 'string'
			)
				invalid();
			return [scope, { connectionId: entry.connectionId, model: entry.model }];
		}),
	);
}

export function parseInferenceSelections(raw: string) {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		invalid();
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
	const entry = value as Record<string, unknown>;
	if (
		entry.version !== 1 ||
		Object.keys(entry).some((key) => !['version', 'selections'].includes(key))
	)
		invalid();
	return {
		version: 1 as const,
		selections: validateInferenceSelections(entry.selections),
	};
}

/** Owns a page's workflow choices independently of its App and UI framework. */
export function createInferenceSelections({
	storage,
	storageKey,
	subscribeStorage,
}: {
	storage: Pick<Storage, 'getItem' | 'setItem'>;
	storageKey: string;
	subscribeStorage?: (listener: () => void) => () => void;
}) {
	const key = `${storageKey}.app-ai-selections`;
	let disposed = false;
	const listeners = new Set<() => void>();
	function load(initial = false) {
		const raw = storage.getItem(key);
		if (
			initial &&
			raw === null &&
			(storage.getItem(`${storageKey}.app-ai`) !== null ||
				storage.getItem(`${storageKey}.inference-targets`) !== null ||
				storage.getItem(`${storageKey}.inference-connections`) !== null)
		)
			throw new Error(
				'Initialize legacy AI settings before opening inference selections.',
			);
		return raw === null
			? { version: 1 as const, selections: {} }
			: parseInferenceSelections(raw);
	}
	let state = load(true);
	function assertOpen() {
		if (disposed) throw new Error('Inference selections are disposed.');
	}
	function notify() {
		for (const listener of listeners) listener();
	}
	const unsubscribe = subscribeStorage?.(() => {
		if (disposed) return;
		const next = load();
		if (JSON.stringify(next) === JSON.stringify(state)) return;
		state = next;
		notify();
	});
	return {
		get(scope: string): InferenceTarget | null {
			assertOpen();
			return Object.hasOwn(state.selections, scope)
				? { ...state.selections[scope]! }
				: null;
		},
		set(scope: string, target: InferenceTarget) {
			assertOpen();
			const next = {
				version: 1 as const,
				selections: validateInferenceSelections({
					...state.selections,
					[scope]: target,
				}),
			};
			storage.setItem(key, JSON.stringify(next));
			state = next;
			notify();
		},
		onChange(listener: () => void) {
			assertOpen();
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		[Symbol.dispose]() {
			if (disposed) return;
			disposed = true;
			listeners.clear();
			unsubscribe?.();
		},
	};
}
export type InferenceSelections = ReturnType<typeof createInferenceSelections>;

export function createBrowserInferenceSelections(storageKey: string) {
	return createInferenceSelections({
		storage: window.localStorage,
		storageKey,
		subscribeStorage(listener) {
			const changed = (event: StorageEvent) => {
				if (
					event.storageArea === window.localStorage &&
					(event.key === `${storageKey}.app-ai-selections` ||
						event.key === null)
				)
					listener();
			};
			window.addEventListener('storage', changed);
			return () => window.removeEventListener('storage', changed);
		},
	});
}

/** The account source's stable id, from the identity the AI capability carries. */
export function accountInferenceId(ai: Pick<AppAi, 'account'>) {
	return ai.account
		? `account:${JSON.stringify([ai.account.identity.authorityId, ai.account.identity.principalId])}`
		: null;
}

export function runtimeInferenceId(ai: Pick<AppAi, 'runtime'>) {
	return ai.runtime ? `runtime:${ai.runtime.client.baseURL}` : null;
}

/** Match one explicit source; unavailable identities never fall through to another source. */
export function matchInferenceTarget(
	ai: AppAi,
	target: InferenceTarget | null,
) {
	if (!target) return null;
	if (target.connectionId === accountInferenceId(ai))
		return ai.account?.client ?? null;
	if (target.connectionId === runtimeInferenceId(ai))
		return ai.runtime?.client ?? null;
	return ai.connections?.get(target.connectionId)?.client ?? null;
}
