/**
 * The page's one way to open a microphone, for recording and for voice
 * activity detection alike. A chosen input is asked for by its exact ID, and
 * when the browser cannot open exactly that one the answer is a refusal: no
 * other microphone is opened in its place. Either way the browser's voice
 * processing is off (see `UNPROCESSED`).
 */
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import { RecorderError, type RecordingInput } from './recording.js';

/** Stop every track, which releases the microphone. */
export const release = (stream: MediaStream) => {
	for (const track of stream.getTracks()) track.stop();
};

/** A browser error's name. `OverconstrainedError` is not a `DOMException` everywhere. */
const nameOf = (cause: unknown) =>
	typeof cause === 'object' && cause !== null && 'name' in cause
		? String(cause.name)
		: '';

/**
 * The microphone as it hears, without echo cancellation, noise suppression,
 * or gain control. Safari's voice processing takes about 2 s to start, and
 * MediaRecorder drops that time from the start of every recording: 2.0 to
 * 2.4 s with `{ audio: true }`, 0.24 to 0.35 s with processing off (a probe
 * in Safari 26.5, November 2026).
 */
const UNPROCESSED = {
	echoCancellation: false,
	noiseSuppression: false,
	autoGainControl: false,
} as const satisfies MediaTrackConstraints;

/**
 * Open one microphone: exactly `input`, or the system default when none is
 * chosen. The caller owns the stream it is given and must release it.
 */
export async function openMicrophone(
	mediaDevices: Pick<MediaDevices, 'getUserMedia'>,
	input: RecordingInput | undefined,
	signal: AbortSignal | undefined,
): Promise<Result<MediaStream, RecorderError>> {
	if (signal?.aborted) return RecorderError.Cancelled();
	const { data: stream, error } = await tryAsync({
		try: () =>
			mediaDevices.getUserMedia({
				audio:
					input === undefined
						? UNPROCESSED
						: { ...UNPROCESSED, deviceId: { exact: input.deviceId } },
			}),
		catch: (cause) => {
			if (signal?.aborted) return RecorderError.Cancelled();
			const name = nameOf(cause);
			if (name === 'NotAllowedError' || name === 'SecurityError')
				return RecorderError.PermissionDenied();
			// An exact ID the browser cannot satisfy: the microphone is not there.
			if (
				input !== undefined &&
				(name === 'OverconstrainedError' || name === 'NotFoundError')
			)
				return RecorderError.InputUnavailable({ label: input.label });
			if (name === 'NotFoundError')
				return RecorderError.NoInputDevice({
					reason: 'no microphone was found',
				});
			return RecorderError.Failed({ cause });
		},
	});
	if (error !== null) return Err(error);
	// Withdrawn while the browser was answering: this stream has no other owner.
	if (signal?.aborted) {
		release(stream);
		return RecorderError.Cancelled();
	}
	if (input !== undefined) {
		// A browser that reports which microphone it opened must report this one.
		const opened = stream.getAudioTracks()[0]?.getSettings().deviceId;
		if (opened !== undefined && opened !== '' && opened !== input.deviceId) {
			release(stream);
			return RecorderError.InputUnavailable({ label: input.label });
		}
	}
	return Ok(stream);
}
