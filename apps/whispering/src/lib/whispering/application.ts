import type {
	WorkspaceDefinition,
	WorkspaceHandle,
} from '@epicenter/workspace/sqlite';
import type { TranscriptionServiceId } from '../services/transcription/providers';
import {
	createWhisperingSettingDefaults,
	type WhisperingSettingValues,
	whisperingWorkspace,
} from '../workspace';
import { createWhisperingRecipes, type WhisperingRecipes } from './recipes';
import {
	createWhisperingRecordings,
	type WhisperingRecordings,
} from './recordings';

type ApplicationRuntime = {
	open<TDefinition extends WorkspaceDefinition>(
		definition: TDefinition,
	): Promise<WorkspaceHandle<TDefinition>>;
	[Symbol.asyncDispose](): Promise<void>;
};

/**
 * The environment-owned inputs for one application acquisition: how to build
 * the workspace runtime, and the platform's default transcription service.
 * The `#platform/whispering` leaves bind these per build; Bun scripts supply
 * their own.
 */
export type WhisperingDependencies = {
	createRuntime(
		onRecordsChanged: (workspaceId: string) => void,
	): ApplicationRuntime;
	defaultTranscriptionService: TranscriptionServiceId;
	reportBackgroundError(cause: unknown): void;
};

/**
 * Hydrated, UI-free settings over the Whispering KV. Reads are synchronous
 * against the hydrated cache; writes are optimistic with re-read repair.
 * `subscribe` fires after any value changes; view adapters use it to make
 * reads reactive.
 */
export type WhisperingSettings = {
	get<TKey extends keyof WhisperingSettingValues>(
		key: TKey,
	): WhisperingSettingValues[TKey];
	set<TKey extends keyof WhisperingSettingValues>(
		key: TKey,
		value: WhisperingSettingValues[TKey],
	): void;
	getDefault<TKey extends keyof WhisperingSettingValues>(
		key: TKey,
	): WhisperingSettingValues[TKey];
	reset(): void;
	readonly loadError: unknown;
	subscribe(listener: () => void): () => void;
};

export type WhisperingApplication = {
	readonly settings: WhisperingSettings;
	readonly recordings: WhisperingRecordings;
	readonly recipes: WhisperingRecipes;
	[Symbol.asyncDispose](): Promise<void>;
};

function clone<TValue>(value: TValue): TValue {
	return structuredClone(value);
}

/**
 * One transactional asynchronous acquisition of a fully ready Whispering
 * application: it opens the Whispering workspace and hydrates settings,
 * recordings, and recipes before resolving. Any failure releases everything
 * it opened and rejects; there is no half-open application state.
 *
 * The caller owns observation: the root Svelte `{#await}` (or a script's
 * `await`) attaches to this promise the moment it exists, so a boot failure
 * always has an observer. Aborting `signal` releases an in-flight acquisition.
 * Once resolved, the caller owns disposal. The Svelte route wraps this core in
 * one UI session so shell work, query state, and the application close in one
 * ordered lifecycle. Boot retry is a full page reload.
 *
 * Scripts: `await using app = await openWhisperingApplication(bunDeps)`.
 */
export async function openWhisperingApplication(
	{
		createRuntime,
		defaultTranscriptionService,
		reportBackgroundError,
	}: WhisperingDependencies,
	{ signal }: { signal?: AbortSignal } = {},
): Promise<WhisperingApplication> {
	const recordListeners = new Map<string, Set<() => void>>();
	const runtime = createRuntime((workspaceId) => {
		for (const listener of recordListeners.get(workspaceId) ?? []) listener();
	});
	let disposeDomains: (() => void) | undefined;

	function onRecordsChanged(
		workspaceId: string,
		listener: () => void,
	): () => void {
		let listeners = recordListeners.get(workspaceId);
		if (!listeners) {
			listeners = new Set();
			recordListeners.set(workspaceId, listeners);
		}
		listeners.add(listener);
		return () => listeners.delete(listener);
	}

	let released = false;
	let releasePromise: Promise<void> | undefined;
	const release = (): Promise<void> => {
		releasePromise ??= (async () => {
			released = true;
			signal?.removeEventListener('abort', onAbort);
			disposeDomains?.();
			recordListeners.clear();
			await runtime[Symbol.asyncDispose]();
		})();
		return releasePromise;
	};
	const aborted = Promise.withResolvers<never>();
	const onAbort = () => {
		aborted.reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
		void release().catch(reportBackgroundError);
	};
	signal?.addEventListener('abort', onAbort, { once: true });
	const untilAbort = <TValue>(work: Promise<TValue>): Promise<TValue> =>
		signal ? Promise.race([work, aborted.promise]) : work;

	try {
		signal?.throwIfAborted();
		const whispering = await untilAbort(runtime.open(whisperingWorkspace));
		signal?.throwIfAborted();
		const settings = await untilAbort(
			hydrateSettings({
				whispering,
				defaults: createWhisperingSettingDefaults(defaultTranscriptionService),
				subscribeRecordsChanged: (listener) =>
					onRecordsChanged(whispering.id, listener),
				isReleased: () => released,
				reportBackgroundError,
			}),
		);
		const recordingsDomain = createWhisperingRecordings({
			workspace: whispering,
			onRecordsChanged: (listener) => onRecordsChanged(whispering.id, listener),
			reportBackgroundError,
		});
		const recipesDomain = createWhisperingRecipes({
			workspace: whispering,
			onRecordsChanged: (listener) => onRecordsChanged(whispering.id, listener),
			reportBackgroundError,
		});
		disposeDomains = () => {
			recordingsDomain.dispose();
			recipesDomain.dispose();
		};
		await untilAbort(
			Promise.all([recordingsDomain.ready, recipesDomain.ready]),
		);
		signal?.throwIfAborted();
		// The signal owns only acquisition. Once ready, the caller owns disposal.
		signal?.removeEventListener('abort', onAbort);
		signal?.throwIfAborted();
		return Object.freeze({
			settings,
			recordings: recordingsDomain.recordings,
			recipes: recipesDomain.recipes,
			[Symbol.asyncDispose]: release,
		});
	} catch (cause) {
		try {
			await release();
		} catch (releaseCause) {
			throw new AggregateError(
				[cause, releaseCause],
				'Whispering application acquisition and cleanup failed',
			);
		}
		throw cause;
	}
}

/**
 * Read every setting into a synchronous cache before the application
 * resolves. The records-changed subscription starts before the first reads so
 * a change landing mid-hydration still triggers a re-read.
 */
async function hydrateSettings({
	whispering,
	defaults,
	subscribeRecordsChanged,
	isReleased,
	reportBackgroundError,
}: {
	whispering: WorkspaceHandle<typeof whisperingWorkspace>;
	defaults: WhisperingSettingValues;
	subscribeRecordsChanged(listener: () => void): () => void;
	isReleased(): boolean;
	reportBackgroundError(cause: unknown): void;
}): Promise<WhisperingSettings> {
	const keys = Object.keys(defaults) as Array<keyof WhisperingSettingValues>;
	const values = new Map<keyof WhisperingSettingValues, unknown>();
	const listeners = new Set<() => void>();
	let loadError: unknown = null;
	let refreshGeneration = 0;
	const notify = () => {
		for (const listener of listeners) listener();
	};

	async function refreshKey<TKey extends keyof WhisperingSettingValues>(
		key: TKey,
	): Promise<void> {
		const { data: storedValue, error } = await whispering.kv.get(key);
		if (error) {
			// A newer release may own this value. Use local policy without repair.
			values.set(key, clone(defaults[key]));
			return;
		}
		values.set(key, clone(storedValue ?? defaults[key]));
	}

	async function refreshAll(): Promise<void> {
		refreshGeneration += 1;
		while (!isReleased()) {
			const generation = refreshGeneration;
			const nextValues = new Map<keyof WhisperingSettingValues, unknown>();
			await Promise.all(
				keys.map(async (key) => {
					const { data: storedValue, error } = await whispering.kv.get(key);
					nextValues.set(
						key,
						clone(error ? defaults[key] : (storedValue ?? defaults[key])),
					);
				}),
			);
			if (isReleased()) return;
			if (generation !== refreshGeneration) continue;
			values.clear();
			for (const [key, value] of nextValues) values.set(key, value);
			loadError = null;
			notify();
			return;
		}
	}

	/** Post-boot failures become observable settings state, never orphaned work. */
	const inBackground = (work: Promise<unknown>): void => {
		void work.then(
			() => {
				if (isReleased() || loadError === null) return;
				loadError = null;
				notify();
			},
			(cause) => {
				if (isReleased()) return;
				loadError = cause;
				notify();
				reportBackgroundError(cause);
			},
		);
	};

	subscribeRecordsChanged(() => {
		inBackground(refreshAll());
	});
	await refreshAll();

	return {
		get<TKey extends keyof WhisperingSettingValues>(key: TKey) {
			return clone(values.get(key) as WhisperingSettingValues[TKey]);
		},
		set<TKey extends keyof WhisperingSettingValues>(
			key: TKey,
			value: WhisperingSettingValues[TKey],
		): void {
			values.set(key, clone(value));
			notify();
			inBackground(
				whispering.kv
					.set(key, clone(value))
					.then(({ error }) =>
						error ? refreshKey(key).then(notify) : undefined,
					),
			);
		},
		getDefault<TKey extends keyof WhisperingSettingValues>(key: TKey) {
			return clone(defaults[key]);
		},
		reset(): void {
			for (const key of keys) {
				values.set(key, clone(defaults[key]));
				inBackground(whispering.kv.unset(key));
			}
			notify();
		},
		get loadError() {
			return loadError;
		},
		subscribe(listener: () => void): () => void {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}
