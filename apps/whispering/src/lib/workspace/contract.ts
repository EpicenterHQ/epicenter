import { BLOB_ID_ROUTE_REGEX, type BlobId } from '@epicenter/blobs';
import {
	defineTable,
	defineValue,
	type RowFor,
	type ValueFor,
} from '@epicenter/data';
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
	namespace: 'so.epicenter.whispering',
	table: 'recordings',
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
	namespace: 'so.epicenter.whispering',
	table: 'recipes',
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

/** Inert singleton definitions for every persisted Whispering setting. */
export const whisperingSettingValues = {
	'sound.manualStart': defineValue({
		namespace: 'so.epicenter.whispering',
		value: 'settings.sound.manual-start',
		schema: field.boolean(),
	}),
	'sound.manualStop': defineValue({
		namespace: 'so.epicenter.whispering',
		value: 'settings.sound.manual-stop',
		schema: field.boolean(),
	}),
	'sound.manualCancel': defineValue({
		namespace: 'so.epicenter.whispering',
		value: 'settings.sound.manual-cancel',
		schema: field.boolean(),
	}),
	'sound.vadStart': defineValue({
		namespace: 'so.epicenter.whispering',
		value: 'settings.sound.vad-start',
		schema: field.boolean(),
	}),
	'sound.vadCapture': defineValue({
		namespace: 'so.epicenter.whispering',
		value: 'settings.sound.vad-capture',
		schema: field.boolean(),
	}),
	'sound.vadStop': defineValue({
		namespace: 'so.epicenter.whispering',
		value: 'settings.sound.vad-stop',
		schema: field.boolean(),
	}),
	'sound.transcriptionComplete': defineValue({
		namespace: 'so.epicenter.whispering',
		value: 'settings.sound.transcription-complete',
		schema: field.boolean(),
	}),
	'sound.recipeComplete': defineValue({
		namespace: 'so.epicenter.whispering',
		value: 'settings.sound.recipe-complete',
		schema: field.boolean(),
	}),
	'output.transcription.clipboard': defineValue({
		namespace: 'so.epicenter.whispering',
		value: 'settings.output.transcription.clipboard',
		schema: field.boolean(),
	}),
	'output.transcription.cursor': defineValue({
		namespace: 'so.epicenter.whispering',
		value: 'settings.output.transcription.cursor',
		schema: field.boolean(),
	}),
	'output.transcription.enter': defineValue({
		namespace: 'so.epicenter.whispering',
		value: 'settings.output.transcription.enter',
		schema: field.boolean(),
	}),
	'output.recipe.clipboard': defineValue({
		namespace: 'so.epicenter.whispering',
		value: 'settings.output.recipe.clipboard',
		schema: field.boolean(),
	}),
	'output.recipe.cursor': defineValue({
		namespace: 'so.epicenter.whispering',
		value: 'settings.output.recipe.cursor',
		schema: field.boolean(),
	}),
	'output.recipe.enter': defineValue({
		namespace: 'so.epicenter.whispering',
		value: 'settings.output.recipe.enter',
		schema: field.boolean(),
	}),
	'recording.trigger': defineValue({
		namespace: 'so.epicenter.whispering',
		value: 'settings.recording.trigger',
		schema: field.select(RECORDING_TRIGGERS),
	}),
	'recording.pausePlayback': defineValue({
		namespace: 'so.epicenter.whispering',
		value: 'settings.recording.pause-playback',
		schema: field.boolean(),
	}),
	'recording.autoUpload': defineValue({
		namespace: 'so.epicenter.whispering',
		value: 'settings.recording.auto-upload',
		schema: field.boolean(),
	}),
	'transcription.service': defineValue({
		namespace: 'so.epicenter.whispering',
		value: 'settings.transcription.service',
		schema: field.select(TRANSCRIPTION_SERVICE_IDS),
	}),
	'transcription.openai.model': defineValue({
		namespace: 'so.epicenter.whispering',
		value: 'settings.transcription.openai.model',
		schema: field.string(),
	}),
	'transcription.groq.model': defineValue({
		namespace: 'so.epicenter.whispering',
		value: 'settings.transcription.groq.model',
		schema: field.string(),
	}),
	'transcription.elevenlabs.model': defineValue({
		namespace: 'so.epicenter.whispering',
		value: 'settings.transcription.elevenlabs.model',
		schema: field.string(),
	}),
	'transcription.deepgram.model': defineValue({
		namespace: 'so.epicenter.whispering',
		value: 'settings.transcription.deepgram.model',
		schema: field.string(),
	}),
	'transcription.mistral.model': defineValue({
		namespace: 'so.epicenter.whispering',
		value: 'settings.transcription.mistral.model',
		schema: field.string(),
	}),
	'transcription.language': defineValue({
		namespace: 'so.epicenter.whispering',
		value: 'settings.transcription.language',
		schema: field.select(SUPPORTED_LANGUAGES),
	}),
	'transcription.prompt': defineValue({
		namespace: 'so.epicenter.whispering',
		value: 'settings.transcription.prompt',
		schema: field.string(),
	}),
	'completion.provider': defineValue({
		namespace: 'so.epicenter.whispering',
		value: 'settings.completion.provider',
		schema: field.select(INFERENCE_PROVIDER_IDS),
	}),
	'completion.model': defineValue({
		namespace: 'so.epicenter.whispering',
		value: 'settings.completion.model',
		schema: field.string(),
	}),
	dictionary: defineValue({
		namespace: 'so.epicenter.whispering',
		value: 'settings.dictionary',
		schema: field.tags(),
	}),
	'polish.enabled': defineValue({
		namespace: 'so.epicenter.whispering',
		value: 'settings.polish.enabled',
		schema: field.boolean(),
	}),
	'polish.instructions': defineValue({
		namespace: 'so.epicenter.whispering',
		value: 'settings.polish.instructions',
		schema: field.string(),
	}),
	'analytics.enabled': defineValue({
		namespace: 'so.epicenter.whispering',
		value: 'settings.analytics.enabled',
		schema: field.boolean(),
	}),
	'shortcut.pushToTalk': defineValue({
		namespace: 'so.epicenter.whispering',
		value: 'settings.shortcut.push-to-talk',
		schema: field.json(KeyBindingSchema),
	}),
	'shortcut.toggleManualRecording': defineValue({
		namespace: 'so.epicenter.whispering',
		value: 'settings.shortcut.toggle-manual-recording',
		schema: field.json(KeyBindingSchema),
	}),
	'shortcut.cancelRecording': defineValue({
		namespace: 'so.epicenter.whispering',
		value: 'settings.shortcut.cancel-recording',
		schema: field.json(KeyBindingSchema),
	}),
	'shortcut.toggleVadRecording': defineValue({
		namespace: 'so.epicenter.whispering',
		value: 'settings.shortcut.toggle-vad-recording',
		schema: field.json(KeyBindingSchema),
	}),
	'shortcut.openRecipePicker': defineValue({
		namespace: 'so.epicenter.whispering',
		value: 'settings.shortcut.open-recipe-picker',
		schema: field.json(KeyBindingSchema),
	}),
	'shortcut.runRecipeOnClipboard': defineValue({
		namespace: 'so.epicenter.whispering',
		value: 'settings.shortcut.run-recipe-on-clipboard',
		schema: field.json(KeyBindingSchema),
	}),
	'shortcut.openSettings': defineValue({
		namespace: 'so.epicenter.whispering',
		value: 'settings.shortcut.open-settings',
		schema: field.json(KeyBindingSchema),
	}),
} as const;

export type WhisperingSettingValues = {
	[K in keyof typeof whisperingSettingValues]: ValueFor<
		(typeof whisperingSettingValues)[K]
	>;
};

/** The inert Whispering definitions. Runtimes bind them to one Epicenter. */
export const whisperingDefinitions = {
	tables: { recordings: recordingsTable, recipes: recipesTable },
	values: whisperingSettingValues,
} as const;
