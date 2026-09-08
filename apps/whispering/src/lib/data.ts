import { APPS } from '@epicenter/constants/apps';
import { field } from '@epicenter/data/definition';
/**
 * Whispering's inert data definition.
 *
 * Pure JSON: closed field descriptors and nothing that knows about
 * storage, sync or documents (ADR-0213). Runtimes own all of that.
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
 * **Transcripts stay in the row.** They are machine-produced, replaced
 * wholesale, and rendered in the recordings list, so nothing about them wants
 * per-character merging. That is the opposite of Honeycrisp's call for a node
 * (ADR-0207) and it is deliberate: a note is written by a person a character at
 * a time, a transcript arrives finished.
 *
 * **There are no optional fields.** A field has to be one type through the CRDT
 * attribute, the projection column and the row alike, and "absent" is not a SQL
 * type. What would have been optional is nullable with a `= null` default,
 * which a read applies and a write never stores.
 */

import type { DeclaredData } from '@epicenter/data';
import {
	defineData,
	defineTable,
	type KvOf,
	plainText,
	type RowOf,
} from '@epicenter/data/definition';

/** Runtime-minted structural row ids. */
export type RecordingId = string;
export type RecipeId = string;

const recordingsTable = defineTable({
	/** Immutable audio bytes owned by this recording and addressed by BlobId. */
	audioBlobId: field.blob(),
	/** Set only after an explicit replica upload succeeds. */
	uploadedAt: field.nullable(field.instant()),
	title: field.string(),
	recordedAt: field.instant(),
	recordedAtZone: field.string(),
	transcript: field.string(),
	polishedTranscript: field.nullable(field.string()),
	duration: field.nullable(field.number()),
	/**
	 * The transcription outcome, flattened into three columns.
	 *
	 * It was one nullable discriminated union, and a workspace cannot express an
	 * inline object: `'{ status: ... }'` does not parse, and `'object|null'`
	 * parses but validates nothing and makes the whole outcome one LWW value.
	 * Three columns keep every field checked and let a failure's message merge
	 * independently of its timestamp.
	 */
	transcriptionStatus: field.string(),
	transcriptionCompletedAt: field.nullable(field.instant()),
	transcriptionError: field.nullable(field.string()),
	content: plainText(),
});

const recipesTable = defineTable({
	/**
	 * No `sourceId`. It existed because the old store let an application choose
	 * a row id and a recipe needed a portable one; the store now refuses chosen
	 * ids by construction (ADR-0206), so a user recipe's identity IS its minted
	 * row id. Built-in recipes keep their `builtin:` ids and remain non-rows.
	 */
	name: field.string(),
	instructions: field.string(),
	icon: field.nullable(field.string()),
	content: plainText(),
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
	soundRecipeComplete: field.boolean(),

	outputTranscriptionClipboard: field.boolean(),
	outputTranscriptionCursor: field.boolean(),
	outputTranscriptionEnter: field.boolean(),
	outputRecipeClipboard: field.boolean(),
	outputRecipeCursor: field.boolean(),
	outputRecipeEnter: field.boolean(),

	recordingTrigger: field.select(['vad', 'manual']),
	recordingPausePlayback: field.boolean(),
	recordingAutoUpload: field.boolean(),

	transcriptionService: field.select([
		'epicenter',
		'OpenAI',
		'Groq',
		'ElevenLabs',
		'Deepgram',
		'Mistral',
		'local',
		'speaches',
	]),
	transcriptionOpenaiModel: field.string(),
	transcriptionGroqModel: field.string(),
	transcriptionElevenlabsModel: field.string(),
	transcriptionDeepgramModel: field.string(),
	transcriptionMistralModel: field.string(),
	/**
	 * A plain string, not a union of the 58 supported languages.
	 *
	 * A hand-written union here would drift from `constants/languages.ts`, and
	 * drift means the declaration refusing a write the UI offered. The app validates
	 * against the const; the three SMALL selects above are spelled out because
	 * a two-to-eight-member union is worth checking at the storage boundary.
	 */
	transcriptionLanguage: field.string(),
	transcriptionPrompt: field.string(),

	completionProvider: field.select([
		'OpenAI',
		'Groq',
		'Anthropic',
		'Google',
		'OpenRouter',
		'Custom',
	]),
	completionModel: field.string(),

	dictionary: field.nullable(field.tags()),
	polishEnabled: field.boolean(),
	polishInstructions: field.string(),
	analyticsEnabled: field.boolean(),

	shortcutPushToTalkModifiers: shortcut.modifiers,
	shortcutPushToTalkKeys: shortcut.keys,
	shortcutToggleManualRecordingModifiers: shortcut.modifiers,
	shortcutToggleManualRecordingKeys: field.nullable(field.tags()),
	shortcutCancelRecordingModifiers: shortcut.modifiers,
	shortcutCancelRecordingKeys: field.nullable(field.tags()),
	shortcutToggleVadRecordingModifiers: shortcut.modifiers,
	shortcutToggleVadRecordingKeys: field.nullable(field.tags()),
	shortcutOpenRecipePickerModifiers: shortcut.modifiers,
	shortcutOpenRecipePickerKeys: field.nullable(field.tags()),
	shortcutRunRecipeOnClipboardModifiers: shortcut.modifiers,
	shortcutRunRecipeOnClipboardKeys: field.nullable(field.tags()),
	shortcutOpenSettingsModifiers: shortcut.modifiers,
	shortcutOpenSettingsKeys: field.nullable(field.tags()),
} as const;

export const whisperingDefinition = defineData({
	id: APPS.WHISPERING.id,
	title: 'Whispering',
	kv: settingsKv,
	tables: {
		recordings: recordingsTable,
		recipes: recipesTable,
	},
});

/** The typed view of one store through Whispering's workspace. */
export type WhisperingData = DeclaredData<typeof whisperingDefinition>;

export type Recording = RowOf<typeof recordingsTable>;
/** The recipe values the picker and editor read. */
export type Recipe = Pick<
	RowOf<typeof recipesTable>,
	'id' | 'name' | 'instructions' | 'icon'
>;
/**
 * The settings values an application composes after a read.
 *
 * Through `KvOf` rather than `typeof settingsKv`, which was the DECLARATION
 * (a record of descriptors) wearing the name of the values.
 */
export type WhisperingSettingValues = KvOf<typeof whisperingDefinition>;

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
	openRecipePicker: ['keyT'],
	runRecipeOnClipboard: ['keyR'],
	openSettings: ['comma'],
} as const;
