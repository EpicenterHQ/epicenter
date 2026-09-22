import type { WhisperingSettingValues } from '../data.js';

export const PERSONAL_DEFAULTS: Pick<
	WhisperingSettingValues,
	'dictionary' | 'polishInstructions' | 'transcriptionPrompt'
> = {
	dictionary: null,
	polishInstructions: 'Fix grammar and punctuation. Keep my wording.',
	transcriptionPrompt: '',
};

export const DEVICE_DEFAULTS: Omit<
	WhisperingSettingValues,
	keyof typeof PERSONAL_DEFAULTS
> = {
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
	transcriptionConnection: null,
	transcriptionModel: '',
	transcriptionLanguage: 'auto',
	completionConnection: null,
	completionModel: '',
	polishEnabled: true,
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

export type BooleanSettingKey = {
	[K in keyof WhisperingSettingValues]: WhisperingSettingValues[K] extends boolean
		? K
		: never;
}[keyof WhisperingSettingValues];
