import { BLOB_ID_ROUTE_REGEX, type BlobId } from '@epicenter/blobs';
import {
	defineLens,
	defineTable,
	defineValues,
	type RowFor,
	type ValueTypeFor,
} from '@epicenter/data/runtime';
import { field } from '@epicenter/field';
import { Type } from 'typebox';
import type { Brand } from 'wellcrafted/brand';
import { RECORDING_TRIGGERS } from '../constants/audio/recording-triggers';
import { INFERENCE_PROVIDER_IDS } from '../constants/inference-provider-ids';
import { SUPPORTED_LANGUAGES } from '../constants/languages';
import { TRANSCRIPTION_SERVICE_IDS } from '../services/transcription/provider-ids';

const TranscriptionOutcome = Type.Union([
	Type.Object({
		status: Type.Literal('completed'),
		completedAt: field.instant(),
	}),
	Type.Object({
		status: Type.Literal('failed'),
		completedAt: field.instant(),
		error: Type.String(),
	}),
]);

export const recordingsTable = defineTable({
	title: 'Recordings',
	fields: {
		/** Opaque local and remote identity for this recording's immutable audio. */
		audioBlobId: field.string<BlobId>({ pattern: `^${BLOB_ID_ROUTE_REGEX}$` }),
		/** Set only after a future explicit replica upload succeeds. */
		uploadedAt: field.json(Type.Union([field.instant(), Type.Null()])),
		title: field.string(),
		recordedAt: field.instant(),
		recordedAtZone: field.string(),
		transcript: field.string(),
		polishedTranscript: field.json(Type.Union([Type.String(), Type.Null()])),
		duration: field.json(Type.Union([Type.Number(), Type.Null()])),
		transcription: field.json(Type.Union([TranscriptionOutcome, Type.Null()])),
	},
});

type RecordingRow = RowFor<typeof recordingsTable>;

/** Structural data identity, independent from the recording's audio blob. */
export type RecordingId = string & Brand<'RecordingId'>;

export type Recording = Omit<RecordingRow, 'id'> & { id: RecordingId };

export const recipesTable = defineTable({
	title: 'Recipes',
	fields: {
		/** Stable portable recipe identity. The canonical record id stays structural. */
		sourceId: field.string(),
		name: field.string(),
		instructions: field.string(),
		icon: field.json(Type.Union([Type.String(), Type.Null()])),
	},
});

type RecipeRecord = RowFor<typeof recipesTable>;

/** App-facing recipe identity remains its portable source id. */
export type Recipe = Omit<RecipeRecord, 'id' | 'sourceId'> & { id: string };

const KeyBindingSchema = Type.Object({
	modifiers: Type.Array(
		Type.Union([
			Type.Literal('ctrl'),
			Type.Literal('alt'),
			Type.Literal('shift'),
			Type.Literal('meta'),
			Type.Literal('fn'),
		]),
	),
	keys: Type.Array(Type.String()),
});

/**
 * Every persisted Whispering setting as one named-values collection. The map
 * keys are the durable record keys inside the `settings` collection.
 */
export const whisperingSettings = defineValues({
	title: 'Settings',
	values: {
		'sound.manualStart': field.boolean(),
		'sound.manualStop': field.boolean(),
		'sound.manualCancel': field.boolean(),
		'sound.vadStart': field.boolean(),
		'sound.vadCapture': field.boolean(),
		'sound.vadStop': field.boolean(),
		'sound.transcriptionComplete': field.boolean(),
		'sound.recipeComplete': field.boolean(),
		'output.transcription.clipboard': field.boolean(),
		'output.transcription.cursor': field.boolean(),
		'output.transcription.enter': field.boolean(),
		'output.recipe.clipboard': field.boolean(),
		'output.recipe.cursor': field.boolean(),
		'output.recipe.enter': field.boolean(),
		'recording.trigger': field.select(RECORDING_TRIGGERS),
		'recording.pausePlayback': field.boolean(),
		'recording.autoUpload': field.boolean(),
		'transcription.service': field.select(TRANSCRIPTION_SERVICE_IDS),
		'transcription.openai.model': field.string(),
		'transcription.groq.model': field.string(),
		'transcription.elevenlabs.model': field.string(),
		'transcription.deepgram.model': field.string(),
		'transcription.mistral.model': field.string(),
		'transcription.language': field.select(SUPPORTED_LANGUAGES),
		'transcription.prompt': field.string(),
		'completion.provider': field.select(INFERENCE_PROVIDER_IDS),
		'completion.model': field.string(),
		dictionary: field.tags(),
		'polish.enabled': field.boolean(),
		'polish.instructions': field.string(),
		'analytics.enabled': field.boolean(),
		'shortcut.pushToTalk': field.json(KeyBindingSchema),
		'shortcut.toggleManualRecording': field.json(KeyBindingSchema),
		'shortcut.cancelRecording': field.json(KeyBindingSchema),
		'shortcut.toggleVadRecording': field.json(KeyBindingSchema),
		'shortcut.openRecipePicker': field.json(KeyBindingSchema),
		'shortcut.runRecipeOnClipboard': field.json(KeyBindingSchema),
		'shortcut.openSettings': field.json(KeyBindingSchema),
	},
});

export type WhisperingSettingValues = {
	[K in keyof (typeof whisperingSettings)['values']]: ValueTypeFor<
		typeof whisperingSettings,
		K
	>;
};

/** The one Whispering Lens. Runtimes bind it to one open Epicenter. */
export const whisperingLens = defineLens({
	namespace: 'so.epicenter.whispering',
	title: 'Whispering',
	description: 'Recordings, recipes, and transcription settings.',
	collections: {
		recordings: recordingsTable,
		recipes: recipesTable,
		settings: whisperingSettings,
	},
});
