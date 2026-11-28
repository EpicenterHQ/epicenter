/**
 * The two sounds around a take: a rising note as it starts and a falling
 * one as it ends, so a person looking at another app hears both. Each is
 * made here from a sine wave, so there is no audio file to ship. A page
 * that may not play sound yet stays silent.
 *
 * Each note opens its own audio output and closes it when the note ends.
 * An output left open counts as an app playing sound, and media pause
 * would then take Whispering itself for music to resume.
 */

/** A soft note that slides from `from` to `to` hertz in about a tenth of a second. */
function note(from: number, to: number) {
	try {
		const context = new AudioContext();
		const now = context.currentTime;
		const oscillator = context.createOscillator();
		const gain = context.createGain();
		oscillator.frequency.setValueAtTime(from, now);
		oscillator.frequency.exponentialRampToValueAtTime(to, now + 0.09);
		gain.gain.setValueAtTime(0.0001, now);
		gain.gain.exponentialRampToValueAtTime(0.12, now + 0.01);
		gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
		oscillator.connect(gain).connect(context.destination);
		oscillator.onended = () => void context.close().catch(() => {});
		oscillator.start(now);
		oscillator.stop(now + 0.15);
	} catch {
		// No sound is better than a take that fails over one.
	}
}

export const sounds = {
	start: () => note(587, 880),
	stop: () => note(880, 587),
};
