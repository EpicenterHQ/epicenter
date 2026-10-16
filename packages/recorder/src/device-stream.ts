import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import {
	asDeviceIdentifier,
	type DeviceAcquisitionOutcome,
	type DeviceIdentifier,
} from './devices';

/**
 * Browser microphone capture constraints for speech audio. Applied to every
 * `getUserMedia` call this module makes.
 */
const SPEECH_MEDIA_TRACK_CONSTRAINTS = {
	channelCount: { ideal: 1 },
	sampleRate: { ideal: 16_000 },
} satisfies MediaTrackConstraints;

export const DeviceStreamError = defineErrors({
	PermissionDenied: ({ cause }: { cause: unknown }) => ({
		message: `We need permission to see your microphones. Check your browser settings and try again. ${extractErrorMessage(cause)}`,
		cause,
	}),
	DeviceConnectionFailed: ({
		deviceId,
		cause,
	}: {
		deviceId: string;
		cause: unknown;
	}) => ({
		message: `Unable to connect to the selected microphone. This could be because the device is already in use by another application, has been disconnected, or lacks proper permissions. ${extractErrorMessage(cause)}`,
		deviceId,
		cause,
	}),
	NoDevicesFound: () => ({
		message:
			"Hmm... We couldn't find any microphones to use. Check your connections and try again!",
	}),
	PreferredDeviceUnavailable: () => ({
		message:
			"We couldn't connect to any microphones. Make sure they're plugged in and try again!",
	}),
});
export type DeviceStreamError = InferErrors<typeof DeviceStreamError>;

export async function getRecordingStream({
	selectedDeviceId,
}: {
	selectedDeviceId: DeviceIdentifier | null;
}): Promise<
	Result<
		{ stream: MediaStream; deviceOutcome: DeviceAcquisitionOutcome },
		DeviceStreamError
	>
> {
	// `exact` is the only deviceId constraint that guarantees the requested
	// microphone (or a clean rejection). `ideal` is browser-overridable
	// (Chrome 130+ lets the permission-bubble choice win, Firefox <90 had
	// quirks), so an exact attempt is what lets us report 'success' honestly.
	if (selectedDeviceId) {
		const { data: stream, error } = await tryAsync({
			try: () =>
				navigator.mediaDevices.getUserMedia({
					audio: {
						...SPEECH_MEDIA_TRACK_CONSTRAINTS,
						deviceId: { exact: selectedDeviceId },
					},
				}),
			catch: (error) =>
				DeviceStreamError.DeviceConnectionFailed({
					deviceId: selectedDeviceId,
					cause: error,
				}),
		});
		if (!error) {
			return Ok({
				stream,
				deviceOutcome: { outcome: 'success', deviceId: selectedDeviceId },
			});
		}
		// Preferred device unavailable; fall through to the system default.
	}

	// Fall back to whatever the browser picks for the default audio input. One
	// `getUserMedia` replaces enumerate-and-try-each: it resolves to a working
	// device and rejects only when none exists (or permission is denied), so we
	// categorize that rejection instead of masking every failure as "no
	// devices" (a denied prompt now surfaces as a permission error, not a
	// missing-microphone one).
	const { data: stream, error } = await tryAsync({
		try: () =>
			navigator.mediaDevices.getUserMedia({
				audio: SPEECH_MEDIA_TRACK_CONSTRAINTS,
			}),
		catch: (error) => {
			const name = error instanceof DOMException ? error.name : '';
			if (name === 'NotAllowedError' || name === 'SecurityError') {
				return DeviceStreamError.PermissionDenied({ cause: error });
			}
			return selectedDeviceId
				? DeviceStreamError.PreferredDeviceUnavailable()
				: DeviceStreamError.NoDevicesFound();
		},
	});
	if (error) return Err(error);

	// Read back which device the browser actually granted so the outcome
	// records it for next time.
	return Ok({
		stream,
		deviceOutcome: {
			outcome: 'fallback',
			reason: selectedDeviceId
				? 'preferred-device-unavailable'
				: 'no-device-selected',
			deviceId: asDeviceIdentifier(
				stream.getAudioTracks()[0]?.getSettings().deviceId ?? '',
			),
		},
	});
}

export function cleanupRecordingStream(stream: MediaStream) {
	for (const track of stream.getTracks()) {
		track.stop();
	}
}
