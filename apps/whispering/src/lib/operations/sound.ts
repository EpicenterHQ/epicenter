import { Ok, type Result } from 'wellcrafted/result';
import type { WhisperingSoundNames } from '$lib/constants/sounds';
import { services } from '$lib/services';
import type { SoundError } from '$lib/services/sound';
import { local } from '../whispering/local.js';
import { DEVICE_DEFAULTS } from './settings.js';

const soundSettingKeyMap = {
	'manual-start': 'soundManualStart',
	'manual-stop': 'soundManualStop',
	'manual-cancel': 'soundManualCancel',
	'vad-start': 'soundVadStart',
	'vad-capture': 'soundVadCapture',
	'vad-stop': 'soundVadStop',
	transcriptionComplete: 'soundTranscriptionComplete',
	recipeComplete: 'soundRecipeComplete',
} as const satisfies Record<WhisperingSoundNames, string>;

export async function playSoundIfEnabled(
	soundName: WhisperingSoundNames,
): Promise<Result<void, SoundError>> {
	if (
		!(
			local.kv.get(soundSettingKeyMap[soundName]) ??
			DEVICE_DEFAULTS[soundSettingKeyMap[soundName]]
		)
	) {
		return Ok(undefined);
	}
	return services.sound.playSound(soundName);
}
