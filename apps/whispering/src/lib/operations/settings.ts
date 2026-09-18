import { getApp } from '../application.js';
import type { WhisperingSettingValues } from '../data.js';

export const APPLICATION_DEFAULTS: WhisperingSettingValues = {
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
	transcriptionService: 'connection',
	transcriptionModel: '',
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

/** Product defaults are applied on read; importing settings performs no reads. */
export const settings = {
	get<TKey extends keyof WhisperingSettingValues>(
		key: TKey,
	): WhisperingSettingValues[TKey] {
		return getApp().device.kv.get(key) ?? APPLICATION_DEFAULTS[key];
	},
};
