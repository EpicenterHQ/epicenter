import type { WhisperingSettingValues } from '../data.js';
import type { WhisperingAppHandle } from '../whispering/app.js';

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
	transcriptionConnection: null,
	transcriptionModel: '',
	transcriptionLanguage: 'auto',
	transcriptionPrompt: '',
	completionConnection: null,
	completionModel: '',
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

export type BooleanSettingKey = {
	[K in keyof WhisperingSettingValues]: WhisperingSettingValues[K] extends boolean
		? K
		: never;
}[keyof WhisperingSettingValues];

/** Read a device setting, applying the product default without writing it. */
export function getSetting<TKey extends keyof WhisperingSettingValues>(
	kv: WhisperingAppHandle['device']['kv'],
	key: TKey,
): WhisperingSettingValues[TKey] {
	return kv.get(key) ?? APPLICATION_DEFAULTS[key];
}
