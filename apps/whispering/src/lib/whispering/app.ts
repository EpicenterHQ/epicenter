import type { App } from '@epicenter/app';
import type { InferenceConnections } from '@epicenter/app-shell/inference-picker';
import type { Account } from '@epicenter/auth';
import type { SyncConnectionStatus } from '@epicenter/data/sync';
import type { WhisperingSettingValues, whisperingDefinition } from '../data';
import type { WhisperingRecording } from '../operations/recording.svelte.js';
import { APPLICATION_DEFAULTS } from '../operations/settings.js';

import {
	createWhisperingRecipes,
	type WhisperingRecipes,
} from './recipes.svelte';
import {
	createWhisperingRecordings,
	type WhisperingRecordings,
} from './recordings';

/** One local or account dataset's retained portable work. */
export type WhisperingAppHandle = App<typeof whisperingDefinition>;

/**
 * Hydrated, UI-free settings over typed singleton values.
 *
 * The account replica's `kv`, which is the one document there is: an authority
 * mints every generation (ADR-0336), so there is no unowned device document to
 * hold a machine's preferences separately any more.
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
	subscribe(listener: () => void): () => void;
};

export type WhisperingApp = {
	readonly signal: AbortSignal;
	/** The UI lifetime still accepts new capture. */
	readonly recordingEnabled: boolean;
	readonly account: Account | null;
	readonly settings: WhisperingSettings;
	readonly inferenceConnections: InferenceConnections;
	readonly recordings: WhisperingRecordings;
	readonly attachments: WhisperingAppHandle['attachments'];
	readonly recipes: WhisperingRecipes;
	readonly recording: WhisperingRecording;
	/**
	 * What sync is doing, or undefined when no connection is attached.
	 *
	 * A refused dial is part of what it is doing: `status().refusal` names the
	 * refusal, and the surface rendering it decides which ones a person can act
	 * on.
	 */
	syncStatus(): SyncConnectionStatus | undefined;
};

/** Build settings, saved recordings, and recipes over one ready framework App. */
export function createWhisperingDomains({
	openedApp,
	account,
}: {
	/** The opened dataset owns tables, blobs, and recording. */
	openedApp: WhisperingAppHandle;
	account: Account | null;
}) {
	const settingsDomain = createWhisperingSettings({ kv: openedApp.kv });
	const recordingsDomain = createWhisperingRecordings({
		table: openedApp.tables.recordings,
		blobs: openedApp.blobs,
	});
	const recipesDomain = createWhisperingRecipes({
		table: openedApp.tables.recipes,
	});

	let disposed = false;
	return Object.freeze({
		signal: openedApp.signal,
		account,
		settings: settingsDomain.settings,
		recordings: recordingsDomain.recordings,
		attachments: openedApp.attachments,
		recipes: recipesDomain,
		// Read off the store's own connection (ADR-0340) rather than off a
		// `SyncConnection` this file held, and passed through whole: a refusal is
		// data on that status, and the surface decides what to say about it.
		syncStatus: () => openedApp.sync.status(),
		[Symbol.dispose]() {
			if (disposed) return;
			disposed = true;
			recipesDomain[Symbol.dispose]();
			recordingsDomain[Symbol.dispose]();
			settingsDomain[Symbol.dispose]();
		},
	});
}

type SettingKey = keyof WhisperingSettingValues;

/**
 * Settings over the workspace's KV, which is one name-addressed root.
 *
 * What this replaces was substantial and every piece of it answered a problem
 * that no longer exists. Settings were one ROW at a chosen id, so there was a
 * row id constant, a `settingFieldName` mapping from setting to column, and a
 * read that had to create the row when it was missing. Reads were asynchronous,
 * so there were per-key read generations, a `bumpGeneration` on every read and
 * write, an `isReleased` guard, and a background write queue that reconciled
 * `loadError` after the fact. Values came back live, so every read and write
 * ran `structuredClone`.
 *
 * KV is a reserved root, reads are synchronous, and a read hands back a plain
 * object or a conformance diagnostic (ADR-0213, ADR-0215, ADR-0216). So a read
 * is a read, a write names its keys, and application recovery handles missing
 * values without creating a row to hold them.
 */
function createWhisperingSettings({ kv }: { kv: WhisperingAppHandle['kv'] }) {
	let values: WhisperingSettingValues = { ...APPLICATION_DEFAULTS };
	const listeners = new Set<() => void>();
	const notify = () => {
		for (const listener of listeners) listener();
	};

	function read(): void {
		// One key at a time, each falling back to this application's own default.
		// A stored value the current release cannot read costs that key and not
		// the object around it, which used to be reconstructed by hand from a
		// whole-object `Result` and its `conforming` half.
		values = Object.fromEntries(
			(Object.keys(APPLICATION_DEFAULTS) as SettingKey[]).map((key) => [
				key,
				kv.get(key) ?? APPLICATION_DEFAULTS[key],
			]),
		) as WhisperingSettingValues;
		notify();
	}

	read();
	const stop = kv.subscribe(read);

	const write = (patch: Partial<WhisperingSettingValues>): void => {
		kv.update(patch);
		// The subscription above already re-read inside the write; nothing left
		// to refresh here.
	};

	const settings: WhisperingSettings = {
		get<TKey extends SettingKey>(key: TKey) {
			return values[key];
		},
		set<TKey extends SettingKey>(
			key: TKey,
			value: WhisperingSettingValues[TKey],
		) {
			write({ [key]: value } as Partial<WhisperingSettingValues>);
		},
		getDefault<TKey extends SettingKey>(key: TKey) {
			return APPLICATION_DEFAULTS[key];
		},
		reset() {
			write(APPLICATION_DEFAULTS);
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};

	return {
		settings,
		[Symbol.dispose]() {
			stop();
			listeners.clear();
		},
	};
}
