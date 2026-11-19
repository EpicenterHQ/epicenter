/**
 * What a recorder does, in the desktop app (`native.ts`, the native recorder
 * plugin) and in a browser (`browser.ts`, `MediaRecorder`). Both write a take
 * to `recordings/<id>.<ext>` and answer its id and length; both list the
 * microphones and open a meter on one for settings.
 *
 * A microphone is named by the id `inputs` lists it under; `null` is the
 * system default. A microphone that is not connected is refused, never
 * swapped for another. The types and error names are the native plugin's,
 * so the page handles both the same way.
 */
import type {
	EndedReason,
	Input,
	RecorderError,
	StoppedRecording,
} from '@epicenter/recorder/native';
import type { Result } from 'wellcrafted/result';

export type { EndedReason, Input, RecorderError, StoppedRecording };

/**
 * A level above this is sound. A microphone that sends nothing louder (a
 * muted one, or one that sends digital silence, about -91 dB) is worth
 * pointing out.
 */
export const HEARD = 0.0005;

type Answer<T> = Promise<Result<T, RecorderError>>;

export type Recorder = {
	/**
	 * Start recording `id` from `device`. `onLevel` hears its level, from 0
	 * to 1, about twenty times a second. `onEnded` hears a capture that ends
	 * on its own (a microphone unplugged); what was captured is still there
	 * for `stop` to finish.
	 */
	start(
		id: string,
		options: {
			device: string | null;
			onEnded: (reason: EndedReason) => void;
			onLevel: (level: number) => void;
		},
	): Answer<null>;
	/** Finish the recording and write it; answers its id and length. */
	stop(): Answer<StoppedRecording>;
	/** The microphones connected now. */
	inputs(): Answer<Input[]>;
	/** Open `device` to hear its level on `onLevel`, recording nothing. Answers the function that closes it. */
	listen(
		device: string | null,
		onLevel: (level: number) => void,
	): Answer<() => void>;
};
