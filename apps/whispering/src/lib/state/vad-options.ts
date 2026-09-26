import type { StartActiveListeningOptions } from '@epicenter/recorder';

/**
 * The Silero tuning knobs Whispering exposes in Recording settings. Keys are
 * the option names `MicVAD.new` accepts; values are deviceConfig entries.
 */
const VAD_TUNABLE_KEYS = {
	redemptionMs: 'recording.vad.redemptionMs',
	minSpeechMs: 'recording.vad.minSpeechMs',
	positiveSpeechThreshold: 'recording.vad.positiveSpeechThreshold',
	negativeSpeechThreshold: 'recording.vad.negativeSpeechThreshold',
	preSpeechPadMs: 'recording.vad.preSpeechPadMs',
} as const;

type VadOption = keyof typeof VAD_TUNABLE_KEYS;
type VadTunableKey = (typeof VAD_TUNABLE_KEYS)[VadOption];

/**
 * Read the device-local VAD tunables into the shape `MicVAD.new` expects.
 *
 * The thresholds live in deviceConfig (mic, room, and accent differ per
 * machine) as strings. An empty string means "unset": the key is omitted from
 * the result rather than coerced to 0 or undefined, because vad-web merges
 * options by shallow spread and an explicit `key: undefined` would clobber its
 * defaults.
 */
export function readVadOptions(
	get: (key: VadTunableKey) => string,
): StartActiveListeningOptions['vadOptions'] {
	const options: NonNullable<StartActiveListeningOptions['vadOptions']> = {};
	for (const [option, key] of Object.entries(VAD_TUNABLE_KEYS) as [
		VadOption,
		VadTunableKey,
	][]) {
		const v = get(key);
		if (v !== '') options[option] = Number(v);
	}
	return options;
}
