import type { WhisperingSoundNames } from '$lib/constants/sounds';
import blipSoundSrc from './sound_ex_machina_Button_Blip.mp3';
import startManualSoundSrc from './zapsplat_household_alarm_clock_button_press_12967.mp3';
import stopVadSoundSrc from './zapsplat_household_alarm_clock_large_snooze_button_press_001_12968.mp3';
import startVadSoundSrc from './zapsplat_household_alarm_clock_large_snooze_button_press_002_12969.mp3';
import cancelSoundSrc from './zapsplat_multimedia_click_button_short_sharp_73510.mp3';
import transcriptionCompleteSoundSrc from './zapsplat_multimedia_ui_notification_classic_bell_synth_success_107505.mp3';

export const soundSources = {
	'manual-start': startManualSoundSrc,
	'manual-cancel': cancelSoundSrc,
	'manual-stop': blipSoundSrc,
	'vad-start': startVadSoundSrc,
	'vad-capture': blipSoundSrc,
	'vad-stop': stopVadSoundSrc,
	transcriptionComplete: transcriptionCompleteSoundSrc,
} satisfies Record<WhisperingSoundNames, string>;
