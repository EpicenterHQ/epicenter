/**
 * How loud a microphone's level sounds, from 0 to 1. A level is linear
 * amplitude, where speech sits near 0.1; hearing is closer to a decibel
 * scale, so this maps -60 dB and below to 0 and 0 dB to 1. Speech lands
 * most of the way up, a quiet room near the bottom. Everything that draws
 * the level draws this.
 */
export function loudness(level: number): number {
	if (!(level > 0)) return 0;
	return Math.min(1, Math.max(0, 1 + (20 * Math.log10(level)) / 60));
}
