/**
 * The listeners of one capture, a recording's or a meter's, on either host:
 * the desktop feeds it from the shell's channel, a browser from the page's
 * own microphone. It keeps the first ending nobody asked for, so a listener
 * that subscribes after it still hears it, and `retire` (the capture's stop
 * or close) silences it for good.
 */
import type { RecordingEndedReason } from './recording.js';

export function createSignals() {
	const levels = new Set<(level: number) => void>();
	const endings = new Set<(reason: RecordingEndedReason) => void>();
	let ended: RecordingEndedReason | undefined;
	let retired = false;
	return {
		/** Tell every level listener how loud the input is. */
		level(level: number) {
			if (retired) return;
			for (const listener of levels) listener(level);
		},
		/** Tell every ending listener why capture ended, once: a later ending is not news. */
		end(reason: RecordingEndedReason) {
			if (retired || ended !== undefined) return;
			ended = reason;
			// A listener may stop the capture, which retires the rest: tell them all.
			for (const listener of [...endings]) listener(reason);
		},
		onLevel(listener: (level: number) => void) {
			if (retired) return () => {};
			levels.add(listener);
			return () => levels.delete(listener);
		},
		onEnded(listener: (reason: RecordingEndedReason) => void) {
			if (retired) return () => {};
			if (ended !== undefined) {
				listener(ended);
				return () => {};
			}
			endings.add(listener);
			return () => endings.delete(listener);
		},
		retire() {
			retired = true;
			levels.clear();
			endings.clear();
		},
	};
}
