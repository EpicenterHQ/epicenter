import type { ModelChoice } from './open-ai.js';

function invalid(): never {
	throw new Error('Invalid persisted model choices.');
}

/** Validate application-owned choices while retaining unavailable references. */
function validateModelChoices(value: unknown): Record<string, ModelChoice> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
	return Object.fromEntries(
		Object.entries(value).map(([scope, value]: [string, unknown]) => {
			if (!value || typeof value !== 'object' || Array.isArray(value))
				invalid();
			const entry = value as Record<string, unknown>;
			if (
				Object.keys(entry).some(
					(key) => !['endpoint', 'model'].includes(key),
				) ||
				typeof entry.endpoint !== 'string' ||
				typeof entry.model !== 'string'
			)
				invalid();
			return [scope, { endpoint: entry.endpoint, model: entry.model }];
		}),
	);
}

function parseModelChoices(raw: string) {
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
		Object.keys(entry).some((key) => !['version', 'choices'].includes(key))
	)
		invalid();
	return {
		version: 1 as const,
		choices: validateModelChoices(entry.choices),
	};
}

/**
 * Owns a page's model choice for each of its workflows (such as `tutor`),
 * independently of its App and UI framework. A choice names an endpoint and
 * a model there; one whose endpoint is gone stays saved and resolves to
 * nothing, so it never falls back to another endpoint.
 */
export function createModelChoices({
	storage,
	storageKey,
	subscribeStorage,
}: {
	storage: Pick<Storage, 'getItem' | 'setItem'>;
	storageKey: string;
	subscribeStorage?: (listener: () => void) => () => void;
}) {
	const key = `${storageKey}.model-choices`;
	let disposed = false;
	const listeners = new Set<() => void>();
	function load() {
		const raw = storage.getItem(key);
		return raw === null
			? { version: 1 as const, choices: {} }
			: parseModelChoices(raw);
	}
	let state = load();
	function assertOpen() {
		if (disposed) throw new Error('Model choices are disposed.');
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
		get(scope: string): ModelChoice | null {
			assertOpen();
			return Object.hasOwn(state.choices, scope)
				? { ...state.choices[scope]! }
				: null;
		},
		set(scope: string, choice: ModelChoice) {
			assertOpen();
			const next = {
				version: 1 as const,
				choices: validateModelChoices({
					...state.choices,
					[scope]: choice,
				}),
			};
			storage.setItem(key, JSON.stringify(next));
			state = next;
			notify();
		},
		subscribe(listener: () => void) {
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
export type ModelChoices = ReturnType<typeof createModelChoices>;

/** This browser's model choices for app `appId`, kept in its storage for the site. */
export function createBrowserModelChoices(appId: string) {
	const storageKey = `${appId}/ai`;
	return createModelChoices({
		storage: window.localStorage,
		storageKey,
		subscribeStorage(listener) {
			const changed = (event: StorageEvent) => {
				if (
					event.storageArea === window.localStorage &&
					(event.key === `${storageKey}.model-choices` || event.key === null)
				)
					listener();
			};
			window.addEventListener('storage', changed);
			return () => window.removeEventListener('storage', changed);
		},
	});
}
