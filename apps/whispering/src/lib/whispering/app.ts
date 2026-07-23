import type {
	BoundLens,
	EpicenterRuntime,
	RecordNotLiveError,
} from '@epicenter/data/runtime';
import type { Result } from 'wellcrafted/result';
import type { TranscriptionServiceId } from '../services/transcription/providers';
import {
	createWhisperingSettingDefaults,
	type WhisperingSettingValues,
	whisperingLens,
} from '../workspace';
import { createWhisperingRecipes, type WhisperingRecipes } from './recipes';
import type { WhisperingBlobs } from './recording-audio';
import {
	createWhisperingRecordings,
	type WhisperingRecordings,
} from './recordings';

export type { WhisperingBlobs } from './recording-audio';

/**
 * The app-facing runtime contract. Whispering never captures record blobs, so
 * the blob source is `never` and any environment's runtime satisfies this.
 */
export type WhisperingEpicenter = EpicenterRuntime<never, unknown>;

export type WhisperingData = BoundLens<typeof whisperingLens, never, unknown>;

/** Environment-owned inputs for one fully acquired Whispering app. */
export type WhisperingAppDependencies = {
	openEpicenter(): Promise<WhisperingEpicenter>;
	blobs: WhisperingBlobs;
	defaultTranscriptionService: TranscriptionServiceId;
	reportBackgroundError(cause: unknown): void;
};

/**
 * Hydrated, UI-free settings over typed singleton values. Reads stay
 * synchronous for existing app consumers; each value subscription refreshes
 * the cache after local or synchronized commits.
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

export type WhisperingApp = {
	readonly settings: WhisperingSettings;
	readonly recordings: WhisperingRecordings;
	readonly recipes: WhisperingRecipes;
	[Symbol.asyncDispose](): Promise<void>;
};

function clone<TValue>(value: TValue): TValue {
	return structuredClone(value);
}

/** Acquire one ready Whispering facade over an environment-owned Epicenter. */
export async function openWhisperingApp(
	{
		openEpicenter,
		blobs,
		defaultTranscriptionService,
		reportBackgroundError,
	}: WhisperingAppDependencies,
	{ signal }: { signal?: AbortSignal } = {},
): Promise<WhisperingApp> {
	let epicenter: WhisperingEpicenter | undefined;
	let disposeDomains: (() => void) | undefined;
	let released = false;
	let releasePromise: Promise<void> | undefined;

	const release = (): Promise<void> => {
		releasePromise ??= (async () => {
			released = true;
			signal?.removeEventListener('abort', onAbort);
			disposeDomains?.();
			await epicenter?.[Symbol.asyncDispose]();
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
		const opened = await untilAbort(
			openEpicenter().then(async (value) => {
				epicenter = value;
				if (released) await value[Symbol.asyncDispose]();
				return value;
			}),
		);
		const whispering = opened.bind(whisperingLens);
		const settingsDomain = createWhisperingSettings({
			data: whispering,
			defaults: createWhisperingSettingDefaults(defaultTranscriptionService),
			isReleased: () => released,
			reportBackgroundError,
		});
		const recordingsDomain = createWhisperingRecordings({
			table: whispering.recordings,
			blobs,
			reportBackgroundError,
		});
		const recipesDomain = createWhisperingRecipes({
			table: whispering.recipes,
			reportBackgroundError,
		});
		disposeDomains = () => {
			settingsDomain.dispose();
			recordingsDomain.dispose();
			recipesDomain.dispose();
		};
		await untilAbort(
			Promise.all([
				settingsDomain.ready,
				recordingsDomain.ready,
				recipesDomain.ready,
			]),
		);
		signal?.throwIfAborted();
		signal?.removeEventListener('abort', onAbort);
		return Object.freeze({
			settings: settingsDomain.settings,
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
				'Whispering app acquisition and cleanup failed',
			);
		}
		throw cause;
	}
}

type SettingKey = keyof WhisperingSettingValues;

/** Reject when a Result-typed write reports its expected failure. */
async function orThrow(
	work: Promise<Result<void, RecordNotLiveError>>,
): Promise<void> {
	const { error } = await work;
	if (error !== null) throw error;
}

function createWhisperingSettings({
	data,
	defaults,
	isReleased,
	reportBackgroundError,
}: {
	data: WhisperingData;
	defaults: WhisperingSettingValues;
	isReleased(): boolean;
	reportBackgroundError(cause: unknown): void;
}) {
	const keys = Object.keys(defaults) as SettingKey[];
	const values = new Map<SettingKey, unknown>();
	const listeners = new Set<() => void>();
	let loadError: unknown = null;
	let refreshGeneration = 0;
	const notify = () => {
		for (const listener of listeners) listener();
	};
	const record = <TKey extends SettingKey>(key: TKey) =>
		data.settings.record(key);

	async function read<TKey extends SettingKey>(key: TKey) {
		const result = await record(key).get();
		return clone(
			result.error === null ? (result.data ?? defaults[key]) : defaults[key],
		);
	}

	async function refreshAll(): Promise<void> {
		refreshGeneration += 1;
		while (!isReleased()) {
			const generation = refreshGeneration;
			const next = await Promise.all(
				keys.map(async (key) => [key, await read(key)] as const),
			);
			if (isReleased()) return;
			if (generation !== refreshGeneration) continue;
			values.clear();
			for (const [key, value] of next) values.set(key, value);
			loadError = null;
			notify();
			return;
		}
	}

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

	const stopValues = keys.map((key) =>
		record(key).subscribe(() => inBackground(refreshAll())),
	);
	const ready = refreshAll();
	const settings: WhisperingSettings = {
		get<TKey extends SettingKey>(key: TKey) {
			return clone(values.get(key) as WhisperingSettingValues[TKey]);
		},
		set<TKey extends SettingKey>(
			key: TKey,
			value: WhisperingSettingValues[TKey],
		) {
			values.set(key, clone(value));
			notify();
			inBackground(orThrow(record(key).set(clone(value))));
		},
		getDefault<TKey extends SettingKey>(key: TKey) {
			return clone(defaults[key]);
		},
		reset() {
			for (const key of keys) {
				values.set(key, clone(defaults[key]));
				inBackground(orThrow(record(key).unset()));
			}
			notify();
		},
		get loadError() {
			return loadError;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};

	return {
		settings,
		ready,
		dispose() {
			refreshGeneration += 1;
			for (const stop of stopValues) stop();
			listeners.clear();
		},
	};
}
