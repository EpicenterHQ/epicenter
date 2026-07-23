import type { ResolvedConnection } from '@epicenter/client';
import type {
	BoundLens,
	BoundLenses,
	FirstAttachmentChoice,
	LensDefinition,
	RecordEpicenter,
	RecordSyncStatus,
	RecordValueLens,
} from '@epicenter/data/record';
import {
	createWhisperingSettingDefaults,
	type RecordingId,
	type WhisperingSettingValues,
	whisperingLens,
	whisperingSettingRecordKeys,
	type whisperingSettingSchemas,
} from '../data';
import type { FinalizedAudio } from '../services/recorder/contract';
import type { TranscriptionServiceId } from '../services/transcription/providers';
import { createWhisperingRecipes, type WhisperingRecipes } from './recipes';
import {
	createWhisperingRecordings,
	type WhisperingRecordings,
} from './recordings';

export type WhisperingData<TSource, TRead, TCreateSource = TSource> = BoundLens<
	typeof whisperingLens,
	TSource,
	TRead,
	TCreateSource
>;

export type WhisperingReplicaIdentityState =
	| { kind: 'ready' }
	| {
			kind: 'principal-mismatch';
			attachedPrincipalId: string;
			signedInPrincipalId: string;
	  };

/** One authenticated Epicenter operation, bound to the identity that began it. */
export type WhisperingAuthenticatedRequest = Readonly<{
	baseURL: string;
	fetch: ResolvedConnection['fetch'];
}>;

type WhisperingEpicenter<TSource, TRead, TCreateSource = TSource> = Pick<
	RecordEpicenter<TSource, TRead>,
	| 'attachment'
	| 'subscribeAttachment'
	| 'syncStatus'
	| 'subscribeSyncStatus'
	| typeof Symbol.asyncDispose
> & {
	bind<const TLenses extends Record<string, LensDefinition>>(
		lenses: TLenses,
	): BoundLenses<TLenses, TSource, TRead, TCreateSource>;
	readonly identity?: WhisperingReplicaIdentityState;
	subscribeIdentity?(
		listener: (state: WhisperingReplicaIdentityState) => void,
	): () => void;
	chooseFirstAttachment?(choice: FirstAttachmentChoice): Promise<void>;
	beginAuthenticatedRequest?(): WhisperingAuthenticatedRequest;
};

/** Environment-owned inputs for one fully acquired Whispering app. */
export type WhisperingAppDependencies<
	TSource = Blob,
	TRead = Blob,
	TCreateSource = TSource,
> = {
	openEpicenter(): Promise<WhisperingEpicenter<TSource, TRead, TCreateSource>>;
	/** Convert product audio into the physical capture source this host owns. */
	prepareAudio(audio: FinalizedAudio): TCreateSource;
	/** Materialize one physical read as the Blob consumed by product code. */
	materializeAudio(read: TRead): Promise<Blob>;
	/** Host-owned direct read path, used when the generic record RPC is unsuitable. */
	readAudio?(id: RecordingId, mediaType: string): Promise<Blob | null>;
	/** Cookie-protected media URL used for streaming playback and downloads. */
	audioUrl?(id: RecordingId): string;
	/** Host-owned same-origin authenticated operation broker. */
	beginAuthenticatedRequest?(): WhisperingAuthenticatedRequest;
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
	readonly identity: WhisperingReplicaIdentityState;
	readonly attachment: RecordEpicenter<unknown, unknown>['attachment'];
	readonly syncStatus: RecordSyncStatus;
	subscribeIdentity(
		listener: (state: WhisperingReplicaIdentityState) => void,
	): () => void;
	subscribeAttachment(
		listener: (
			attachment: RecordEpicenter<unknown, unknown>['attachment'],
		) => void,
	): () => void;
	subscribeSyncStatus(listener: (status: RecordSyncStatus) => void): () => void;
	chooseFirstAttachment(choice: FirstAttachmentChoice): Promise<void>;
	/**
	 * Bind an Epicenter HTTP operation to the current authenticated identity.
	 * Browser runtimes generation-fence the returned transport so an account
	 * switch cannot redirect already-started work through the new principal.
	 */
	beginAuthenticatedRequest?(): WhisperingAuthenticatedRequest;
	[Symbol.asyncDispose](): Promise<void>;
};

function clone<TValue>(value: TValue): TValue {
	return structuredClone(value);
}

/** Acquire one ready Whispering facade over an environment-owned Epicenter. */
export async function openWhisperingApp<TSource, TRead, TCreateSource>(
	{
		openEpicenter,
		prepareAudio,
		materializeAudio,
		readAudio,
		audioUrl,
		beginAuthenticatedRequest,
		defaultTranscriptionService,
		reportBackgroundError,
	}: WhisperingAppDependencies<TSource, TRead, TCreateSource>,
	{ signal }: { signal?: AbortSignal } = {},
): Promise<WhisperingApp> {
	let epicenter: WhisperingEpicenter<TSource, TRead, TCreateSource> | undefined;
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
		if (opened.identity?.kind === 'principal-mismatch') {
			throw new Error(
				`These local recordings belong to principal '${opened.identity.attachedPrincipalId}', not the signed-in principal '${opened.identity.signedInPrincipalId}'. Sign back into the original account or reset this site's local data.`,
			);
		}
		const whispering = opened.bind({ whispering: whisperingLens }).whispering;
		const settingsDomain = createWhisperingSettings({
			data: whispering,
			defaults: createWhisperingSettingDefaults(defaultTranscriptionService),
			isReleased: () => released,
			reportBackgroundError,
		});
		const recordingsDomain = createWhisperingRecordings({
			table: whispering.recordings,
			prepareAudio,
			materializeAudio,
			readAudio,
			audioUrl,
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
			get identity() {
				return opened.identity ?? { kind: 'ready' };
			},
			get attachment() {
				return opened.attachment;
			},
			get syncStatus() {
				return opened.syncStatus;
			},
			subscribeIdentity(
				listener: (state: WhisperingReplicaIdentityState) => void,
			) {
				return opened.subscribeIdentity?.(listener) ?? (() => undefined);
			},
			subscribeAttachment(
				listener: (
					attachment: RecordEpicenter<unknown, unknown>['attachment'],
				) => void,
			) {
				return opened.subscribeAttachment(listener);
			},
			subscribeSyncStatus(listener: (status: RecordSyncStatus) => void) {
				return opened.subscribeSyncStatus(listener);
			},
			chooseFirstAttachment(choice: FirstAttachmentChoice) {
				if (opened.chooseFirstAttachment === undefined) {
					return Promise.reject(
						new Error('This runtime has no remote attachment to choose'),
					);
				}
				return opened.chooseFirstAttachment(choice);
			},
			...(opened.beginAuthenticatedRequest === undefined &&
			beginAuthenticatedRequest === undefined
				? {}
				: {
						beginAuthenticatedRequest:
							opened.beginAuthenticatedRequest ?? beginAuthenticatedRequest,
					}),
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

function createWhisperingSettings({
	data,
	defaults,
	isReleased,
	reportBackgroundError,
}: {
	data: WhisperingData<unknown, unknown>;
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
	const lens = <TKey extends SettingKey>(key: TKey) => {
		const recordKey = whisperingSettingRecordKeys[key];
		return data.settings[recordKey] as RecordValueLens<
			(typeof whisperingSettingSchemas)[typeof recordKey]
		>;
	};

	async function read<TKey extends SettingKey>(key: TKey) {
		const result = await lens(key).get();
		return {
			value: clone(
				result.error === null ? (result.data ?? defaults[key]) : defaults[key],
			),
			error: result.error,
		};
	}

	async function refreshAll(): Promise<void> {
		refreshGeneration += 1;
		while (!isReleased()) {
			const generation = refreshGeneration;
			const reads = await Promise.all(
				keys.map(async (key) => [key, await read(key)] as const),
			);
			if (isReleased()) return;
			if (generation !== refreshGeneration) continue;
			values.clear();
			const errors: unknown[] = [];
			for (const [key, result] of reads) {
				values.set(key, result.value);
				if (result.error !== null) errors.push(result.error);
			}
			loadError =
				errors.length === 0
					? null
					: errors.length === 1
						? errors[0]
						: new AggregateError(
								errors,
								'Whispering settings contain nonconforming values',
							);
			if (loadError !== null) reportBackgroundError(loadError);
			notify();
			return;
		}
	}

	const inBackground = (work: Promise<unknown>): void => {
		void work.then(
			() => undefined,
			(cause) => {
				if (isReleased()) return;
				loadError = cause;
				notify();
				reportBackgroundError(cause);
			},
		);
	};

	const stopValues = keys.map((key) =>
		lens(key).subscribe(() => inBackground(refreshAll())),
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
			inBackground(lens(key).set(clone(value)));
		},
		getDefault<TKey extends SettingKey>(key: TKey) {
			return clone(defaults[key]);
		},
		reset() {
			for (const key of keys) {
				values.set(key, clone(defaults[key]));
				inBackground(lens(key).unset());
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
