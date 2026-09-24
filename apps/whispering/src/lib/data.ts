import {
	defineStore,
	defineTable,
	field,
	type KvOf,
	plainText,
	type RowOf,
} from '@epicenter/app';
import type { DeclaredData } from '@epicenter/app/store';
import type { BlobId } from '@epicenter/blobs';
import { BLOB_ID_ROUTE_REGEX } from '@epicenter/blobs';
import { APPS } from '@epicenter/constants/apps';

/**
 * Whispering's inert application declaration.
 *
 * The root schema is inspectable without opening storage. Only `openLocal()`
 * acquires the live App and its resources.
 *
 * Three things about this file are decisions rather than transcription of the
 * old contract, and each is load-bearing.
 *
 * **Settings live in `kv`, not in a table.** They used to be one row at the
 * chosen id `'settings'`. A chosen row id is a nested container addressed by
 * the operation that created it, so two devices both writing settings on their
 * own boot path create two containers and map LWW discards one along with every
 * value in it. KV lives at a name-addressed root, where independent minting
 * converges (ADR-0216).
 *
 * **Transcripts stay in result rows.** They are machine-produced, written
 * whole, and rendered in the recordings list, so nothing about them wants
 * per-character merging. That is the opposite of Honeycrisp's call for a node
 * (ADR-0207) and it is deliberate: a note is written by a person a character at
 * a time, a transcript arrives finished.
 *
 * **There are no optional fields.** A field has to be one type through the CRDT
 * attribute, the projection column and the row alike, and "absent" is not a SQL
 * type. What would have been optional is nullable with a `= null` default,
 * which a read applies and a write never stores.
 */

/** Runtime-minted structural row ids. */
export type RecordingId = string;

const recordingsTable = defineTable({
	fields: {
		/** Immutable bytes addressed only through this recording's containing store. */
		audioBlobId: field.string<BlobId>({ pattern: `^${BLOB_ID_ROUTE_REGEX}$` }),
		title: field.string(),
		recordedAt: field.instant(),
		recordedAtZone: field.string(),
		duration: field.nullable(field.number()),
	},
	body: plainText(),
});

/** Each successful inference keeps its own Original and accepted Cleaned text. */
const transcriptionsTable = defineTable({
	fields: {
		recordingId: field.string(),
		attemptedAt: field.instant(),
		completedAt: field.instant(),
		rawText: field.string(),
		cleanedText: field.nullable(field.string()),
		connectionId: field.nullable(field.string()),
		model: field.nullable(field.string()),
		/** Marks the single result copied from an older recording-wide transcript. */
		legacyRecordingId: field.nullable(field.string()),
	},
	body: plainText(),
});

/** Local handoff receipts survive a lost acknowledgement or a page reload. */
const capturePromotionsTable = defineTable({
	fields: {
		resultId: field.string(),
		requestId: field.string(),
		authorityId: field.string(),
		principalId: field.string(),
		text: field.string(),
		capturedAt: field.instant(),
		captureId: field.nullable(field.string()),
	},
});

/**
 * A shortcut, as two fields.
 *
 * Same gap as the transcription outcome: a `{ modifiers, keys }` object has no
 * string expression. There is no lossless label codec in `utils/key-binding.ts`
 * either (`keyBindingToLabel` and `keyBindingToAccelerator` are one-way), so a
 * canonical single-string encoding would have to be invented and tested. Two
 * arrays need neither.
 *
 * Nullable rather than optional, because missing remains a conformance error and
 * initialization belongs to the application. Every array field uses this same law.
 */
const shortcut = {
	modifiers: field.nullable(
		field.multiSelect(['ctrl', 'alt', 'shift', 'meta', 'fn']),
	),
	keys: field.nullable(field.tags()),
} as const;

const settingsKv = {
	soundManualStart: field.boolean(),
	soundManualStop: field.boolean(),
	soundManualCancel: field.boolean(),
	soundVadStart: field.boolean(),
	soundVadCapture: field.boolean(),
	soundVadStop: field.boolean(),
	soundTranscriptionComplete: field.boolean(),

	outputTranscriptionClipboard: field.boolean(),
	outputTranscriptionCursor: field.boolean(),
	outputTranscriptionEnter: field.boolean(),

	recordingTrigger: field.select(['vad', 'manual']),
	recordingPausePlayback: field.boolean(),

	transcriptionConnection: field.nullable(field.string()),
	transcriptionModel: field.string(),
	/**
	 * A plain string, not a union of the 58 supported languages.
	 *
	 * A hand-written union here would drift from `constants/languages.ts`, and
	 * drift means the declaration refusing a write the UI offered. The app validates
	 * against the const; the three SMALL selects above are spelled out because
	 * a two-to-eight-member union is worth checking at the storage boundary.
	 */
	transcriptionLanguage: field.string(),

	completionConnection: field.nullable(field.string()),
	completionModel: field.string(),

	polishEnabled: field.boolean(),
	analyticsEnabled: field.boolean(),

	shortcutPushToTalkModifiers: shortcut.modifiers,
	shortcutPushToTalkKeys: shortcut.keys,
	shortcutToggleManualRecordingModifiers: shortcut.modifiers,
	shortcutToggleManualRecordingKeys: field.nullable(field.tags()),
	shortcutCancelRecordingModifiers: shortcut.modifiers,
	shortcutCancelRecordingKeys: field.nullable(field.tags()),
	shortcutToggleVadRecordingModifiers: shortcut.modifiers,
	shortcutToggleVadRecordingKeys: field.nullable(field.tags()),
	shortcutOpenSettingsModifiers: shortcut.modifiers,
	shortcutOpenSettingsKeys: field.nullable(field.tags()),
} as const;

const speechProfileKv = {
	dictionary: field.nullable(field.tags()),
	transcriptionPrompt: field.string(),
	polishInstructions: field.string(),
} as const;

export const whisperingDefinition = defineStore({
	id: APPS.WHISPERING.id,
	title: 'Whispering',
	kv: settingsKv,
	tables: {
		recordings: recordingsTable,
		transcriptions: transcriptionsTable,
		capturePromotions: capturePromotionsTable,
	},
});

/** Account-bound vocabulary and instructions, without a recording table. */
export const speechProfileDefinition = defineStore({
	id: 'so.epicenter.whispering.speech',
	title: 'Whispering speech profile',
	kv: speechProfileKv,
	tables: {},
});

/** The typed view of one store through Whispering's workspace. */
export type WhisperingData = DeclaredData<typeof whisperingDefinition>;

export type Recording = RowOf<typeof recordingsTable>;
export type Transcription = RowOf<typeof transcriptionsTable>;
export type CapturePromotion = RowOf<typeof capturePromotionsTable>;
/**
 * The settings values an application composes after a read.
 *
 * Through `KvOf` rather than `typeof settingsKv`, which was the DECLARATION
 * (a record of descriptors) wearing the name of the values.
 */
export type WhisperingSettingValues = KvOf<typeof whisperingDefinition>;
export type SpeechProfileSettingValues = KvOf<typeof speechProfileDefinition>;

/**
 * Default shortcuts, applied by the app rather than declared in the definition.
 *
 * The definition does not own initialization, so `keys` uses null for "no shortcut
 * configured" and the app applies shipped shortcuts separately.
 * These are release-local product policy anyway, which is where they were
 * before (`definition.ts`), and they are the only part of that file worth
 * keeping.
 */
export const DEFAULT_SHORTCUT_KEYS = {
	toggleManualRecording: ['space'],
	cancelRecording: ['keyC'],
	toggleVadRecording: ['keyV'],
	openSettings: ['comma'],
} as const;
