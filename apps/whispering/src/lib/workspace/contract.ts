import {
	defineLens,
	defineTable,
	defineValues,
	type RowFor,
	type ValueFor,
} from '@epicenter/data/record';
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
	description:
		'Whispering recording metadata. Each live row owns one write-once audio blob at the same record address.',
	fields: {
		title: field.string(),
		audioMediaType: field.string(),
		audioFileName: field.string(),
		recordedAt: field.instant(),
		recordedAtZone: field.string(),
		transcript: field.string(),
		polishedTranscript: field.json(Type.Union([Type.String(), Type.Null()])),
		duration: field.json(Type.Union([Type.Number(), Type.Null()])),
		transcription: field.json(Type.Union([TranscriptionOutcome, Type.Null()])),
	},
	optional: [],
});

type RecordingRow = RowFor<typeof recordingsTable>;

/** Structural identity of the record that also owns this recording's audio. */
export type RecordingId = string & Brand<'RecordingId'>;

export const WHISPERING_DESKTOP_AUDIO_ROUTE =
	'/_epicenter/media/whispering/recordings/:recordingId/audio';
export const EPICENTER_DESKTOP_AI_BASE_ROUTE = '/_epicenter/ai';

export function whisperingDesktopAudioUrl(
	baseURL: string,
	recordingId: RecordingId,
): string {
	const path = WHISPERING_DESKTOP_AUDIO_ROUTE.replace(
		':recordingId',
		encodeURIComponent(recordingId),
	);
	return new URL(path, baseURL).toString();
}

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
	optional: [],
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

/** Canonical local record keys for settings within the `settings` collection. */
export const whisperingSettingSchemas = {
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
	recordingTrigger: field.select(RECORDING_TRIGGERS),
	recordingPausePlayback: field.boolean(),
	transcriptionService: field.select(TRANSCRIPTION_SERVICE_IDS),
	transcriptionOpenaiModel: field.string(),
	transcriptionGroqModel: field.string(),
	transcriptionElevenlabsModel: field.string(),
	transcriptionDeepgramModel: field.string(),
	transcriptionMistralModel: field.string(),
	transcriptionLanguage: field.select(SUPPORTED_LANGUAGES),
	transcriptionPrompt: field.string(),
	completionProvider: field.select(INFERENCE_PROVIDER_IDS),
	completionModel: field.string(),
	dictionary: field.tags(),
	polishEnabled: field.boolean(),
	polishInstructions: field.string(),
	analyticsEnabled: field.boolean(),
	shortcutPushToTalk: field.json(KeyBindingSchema),
	shortcutToggleManualRecording: field.json(KeyBindingSchema),
	shortcutCancelRecording: field.json(KeyBindingSchema),
	shortcutToggleVadRecording: field.json(KeyBindingSchema),
	shortcutOpenRecipePicker: field.json(KeyBindingSchema),
	shortcutRunRecipeOnClipboard: field.json(KeyBindingSchema),
	shortcutOpenSettings: field.json(KeyBindingSchema),
} as const;

export const settingsValues = defineValues({
	title: 'Settings',
	description: 'Persisted Whispering preferences.',
	values: whisperingSettingSchemas,
});

/**
 * App vocabulary projected onto canonical record keys. Dotted names are the
 * settings API used by product code, not alternate persisted addresses.
 */
export const whisperingSettingRecordKeys = {
	'sound.manualStart': 'soundManualStart',
	'sound.manualStop': 'soundManualStop',
	'sound.manualCancel': 'soundManualCancel',
	'sound.vadStart': 'soundVadStart',
	'sound.vadCapture': 'soundVadCapture',
	'sound.vadStop': 'soundVadStop',
	'sound.transcriptionComplete': 'soundTranscriptionComplete',
	'sound.recipeComplete': 'soundRecipeComplete',
	'output.transcription.clipboard': 'outputTranscriptionClipboard',
	'output.transcription.cursor': 'outputTranscriptionCursor',
	'output.transcription.enter': 'outputTranscriptionEnter',
	'output.recipe.clipboard': 'outputRecipeClipboard',
	'output.recipe.cursor': 'outputRecipeCursor',
	'output.recipe.enter': 'outputRecipeEnter',
	'recording.trigger': 'recordingTrigger',
	'recording.pausePlayback': 'recordingPausePlayback',
	'transcription.service': 'transcriptionService',
	'transcription.openai.model': 'transcriptionOpenaiModel',
	'transcription.groq.model': 'transcriptionGroqModel',
	'transcription.elevenlabs.model': 'transcriptionElevenlabsModel',
	'transcription.deepgram.model': 'transcriptionDeepgramModel',
	'transcription.mistral.model': 'transcriptionMistralModel',
	'transcription.language': 'transcriptionLanguage',
	'transcription.prompt': 'transcriptionPrompt',
	'completion.provider': 'completionProvider',
	'completion.model': 'completionModel',
	dictionary: 'dictionary',
	'polish.enabled': 'polishEnabled',
	'polish.instructions': 'polishInstructions',
	'analytics.enabled': 'analyticsEnabled',
	'shortcut.pushToTalk': 'shortcutPushToTalk',
	'shortcut.toggleManualRecording': 'shortcutToggleManualRecording',
	'shortcut.cancelRecording': 'shortcutCancelRecording',
	'shortcut.toggleVadRecording': 'shortcutToggleVadRecording',
	'shortcut.openRecipePicker': 'shortcutOpenRecipePicker',
	'shortcut.runRecipeOnClipboard': 'shortcutRunRecipeOnClipboard',
	'shortcut.openSettings': 'shortcutOpenSettings',
} as const;

export type WhisperingSettingValues = {
	[K in keyof typeof whisperingSettingRecordKeys]: ValueFor<
		(typeof whisperingSettingSchemas)[(typeof whisperingSettingRecordKeys)[K]]
	>;
};

/** The one inert, pure-JSON projection Whispering binds to a record Epicenter. */
export const whisperingLens = defineLens({
	namespace: 'so.epicenter.whispering',
	title: 'Whispering',
	description: 'Recordings, recipes, and product settings for Whispering.',
	collections: {
		recordings: recordingsTable,
		recipes: recipesTable,
		settings: settingsValues,
	},
});
