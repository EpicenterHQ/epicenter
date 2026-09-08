import type { Account } from '@epicenter/auth';
import type { ReplicaData } from '@epicenter/data';
import type { SyncConnectionStatus } from '@epicenter/data/sync';
import type { WhisperingSettingValues, whisperingDefinition } from '../data';

import {
	createWhisperingRecipes,
	type WhisperingRecipes,
} from './recipes.svelte';
import type { WhisperingBlobs } from './recording-audio';
import {
	createWhisperingRecordings,
	type WhisperingRecordings,
} from './recordings';

export type { WhisperingBlobs } from './recording-audio';

/** One account's retained replica of the portable work. */
export type WhisperingAccountData = ReplicaData<typeof whisperingDefinition>;

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

/** Release-local initialization and recovery values for the device KV. */
// TYPED COMPLETE, not `Partial`. `read` below builds the settings object by
// walking these keys, so a key declared in `settingsKv` and missing here would
// vanish from settings silently rather than fall back. `Partial` allowed
// exactly that; the full record makes the drift a compile error.
const APPLICATION_DEFAULTS: WhisperingSettingValues = {
	soundManualStart: true,
	soundManualStop: true,
	soundManualCancel: true,
	soundVadStart: true,
	soundVadCapture: true,
	soundVadStop: true,
	soundTranscriptionComplete: true,
	soundRecipeComplete: true,
	outputTranscriptionClipboard: true,
	outputTranscriptionCursor: false,
	outputTranscriptionEnter: false,
	outputRecipeClipboard: true,
	outputRecipeCursor: false,
	outputRecipeEnter: false,
	recordingTrigger: 'manual',
	recordingPausePlayback: false,
	recordingAutoUpload: false,
	transcriptionService: 'local',
	transcriptionOpenaiModel: 'whisper-1',
	transcriptionGroqModel: 'whisper-large-v3-turbo',
	transcriptionElevenlabsModel: 'scribe_v2',
	transcriptionDeepgramModel: 'nova-3',
	transcriptionMistralModel: 'voxtral-mini-latest',
	transcriptionLanguage: 'auto',
	transcriptionPrompt: '',
	completionProvider: 'Google',
	completionModel: 'gemini-2.5-flash',
	dictionary: null,
	polishEnabled: true,
	polishInstructions: 'Fix grammar and punctuation. Keep my wording.',
	analyticsEnabled: true,
	shortcutPushToTalkModifiers: null,
	shortcutPushToTalkKeys: null,
	shortcutToggleManualRecordingModifiers: null,
	shortcutToggleManualRecordingKeys: null,
	shortcutCancelRecordingModifiers: null,
	shortcutCancelRecordingKeys: null,
	shortcutToggleVadRecordingModifiers: null,
	shortcutToggleVadRecordingKeys: null,
	shortcutOpenRecipePickerModifiers: null,
	shortcutOpenRecipePickerKeys: null,
	shortcutRunRecipeOnClipboardModifiers: null,
	shortcutRunRecipeOnClipboardKeys: null,
	shortcutOpenSettingsModifiers: null,
	shortcutOpenSettingsKeys: null,
};

export type WhisperingApp = {
	readonly account: Account;
	readonly settings: WhisperingSettings;
	readonly recordings: WhisperingRecordings;
	readonly recipes: WhisperingRecipes;
	/**
	 * This account's audio bytes, reached by the id a row cites.
	 *
	 * On the app rather than on a module-level service, because the store is
	 * one account's (ADR-0349) and so cannot exist before the session that
	 * knows which account. This is Whispering's own object; which platform
	 * object carries the blob verbs is reopened by ADR-0352 and not decided
	 * here.
	 */
	readonly blobs: WhisperingBlobs;
	/**
	 * What sync is doing, or undefined when no connection is attached.
	 *
	 * A refused dial is part of what it is doing: `status().refusal` names the
	 * refusal, and the surface rendering it decides which ones a person can act
	 * on.
	 */
	syncStatus(): SyncConnectionStatus | undefined;
};

/**
 * Build Whispering's domains over one already-open replica.
 *
 * Synchronous, and it opens nothing. This used to be `openWhisperingApp`: it
 * took an `AuthClient`, refused a signed-out one by throwing, built its own
 * `createEpicenter` handle, awaited `open()`, and unwound what the open had
 * acquired when an `AbortSignal` landed mid-flight. All four of those belong
 * somewhere else now. Opening is a verb the session owns (ADR-0344) and
 * `$lib/epicenter.svelte.ts` holds the one handle; a signed-out person is
 * shown a door by the layout rather than an exception; and there is no
 * in-flight open here to abort.
 *
 * What is left is the part that was always this application's: settings over
 * the KV, recordings over their table and blobs, and recipes over theirs.
 *
 * Disposal is on the RESULT, not on `WhisperingApp`. `WhisperingApp` is what a
 * component reads through context, and a type that carried `[Symbol.dispose]`
 * would let any descendant end the domains this session owns. The one caller
 * that may is the module local holding this return value.
 */
export function createWhisperingApp({
	data,
	blobs,
	account,
}: {
	/** The open replica, as `session.opened` resolved it. */
	data: WhisperingAccountData;
	blobs: WhisperingBlobs;
	account: Account;
}): WhisperingApp & Disposable {
	const settingsDomain = createWhisperingSettings({ kv: data.kv });
	const recordingsDomain = createWhisperingRecordings({
		table: data.tables.recordings,
		blobs,
	});
	const recipesDomain = createWhisperingRecipes({
		table: data.tables.recipes,
	});

	let disposed = false;
	return Object.freeze({
		account,
		settings: settingsDomain.settings,
		recordings: recordingsDomain.recordings,
		recipes: recipesDomain,
		blobs,
		// Read off the store's own connection (ADR-0340) rather than off a
		// `SyncConnection` this file held, and passed through whole: a refusal is
		// data on that status, and the surface decides what to say about it.
		syncStatus: () => data.sync.status(),
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
function createWhisperingSettings({ kv }: { kv: WhisperingAccountData['kv'] }) {
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
