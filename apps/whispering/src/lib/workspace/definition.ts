import {
	PROVIDERS,
	type TranscriptionServiceId,
} from '../services/transcription/providers';
import type { KeyBinding } from '../utils/key-binding';
import type { WhisperingSettingValues } from './contract';

export * from './contract';

const EMPTY_BINDING: KeyBinding = { modifiers: [], keys: [] };

/** Product defaults are release-local policy, never persisted document schema. */
export function createWhisperingSettingDefaults(
	defaultTranscriptionService: TranscriptionServiceId,
): WhisperingSettingValues {
	return {
		'sound.manualStart': true,
		'sound.manualStop': true,
		'sound.manualCancel': true,
		'sound.vadStart': true,
		'sound.vadCapture': true,
		'sound.vadStop': true,
		'sound.transcriptionComplete': true,
		'sound.recipeComplete': true,
		'output.transcription.clipboard': true,
		'output.transcription.cursor': false,
		'output.transcription.enter': false,
		'output.recipe.clipboard': true,
		'output.recipe.cursor': false,
		'output.recipe.enter': false,
		'recording.trigger': 'manual',
		'recording.pausePlayback': false,
		'transcription.service': defaultTranscriptionService,
		'transcription.openai.model': PROVIDERS.OpenAI.defaultModel,
		'transcription.groq.model': PROVIDERS.Groq.defaultModel,
		'transcription.elevenlabs.model': PROVIDERS.ElevenLabs.defaultModel,
		'transcription.deepgram.model': PROVIDERS.Deepgram.defaultModel,
		'transcription.mistral.model': PROVIDERS.Mistral.defaultModel,
		'transcription.language': 'auto',
		'transcription.prompt': '',
		'completion.provider': 'Google',
		'completion.model': 'gemini-2.5-flash',
		dictionary: [],
		'polish.enabled': true,
		'polish.instructions': 'Fix grammar and punctuation. Keep my wording.',
		'analytics.enabled': true,
		'shortcut.pushToTalk': EMPTY_BINDING,
		'shortcut.toggleManualRecording': { modifiers: [], keys: ['space'] },
		'shortcut.cancelRecording': { modifiers: [], keys: ['keyC'] },
		'shortcut.toggleVadRecording': { modifiers: [], keys: ['keyV'] },
		'shortcut.openRecipePicker': { modifiers: [], keys: ['keyT'] },
		'shortcut.runRecipeOnClipboard': { modifiers: [], keys: ['keyR'] },
		'shortcut.openSettings': { modifiers: ['meta'], keys: ['comma'] },
	};
}
