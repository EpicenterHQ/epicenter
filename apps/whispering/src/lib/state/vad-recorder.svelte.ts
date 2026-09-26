import {
	asDeviceIdentifier,
	createVadRecorder,
	enumerateDevices,
} from '@epicenter/recorder';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { defineKeys, resultQueryOptions } from 'wellcrafted/query';
import { Ok } from 'wellcrafted/result';
import type { VadState } from '$lib/constants/audio';
import { WHISPERING_BASE_PATHNAME } from '$lib/constants/urls';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { readVadOptions } from './vad-options';

const VadRecorderError = defineErrors({
	EnumerateDevicesFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to enumerate devices: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

const vadKeys = defineKeys({
	devices: ['vad', 'devices'],
});

/**
 * Thin reactive wrapper over `@epicenter/recorder`'s callback VAD core.
 *
 * The portable VAD lives in the package (`createVadRecorder`). This wrapper adds
 * the two pieces that are Whispering's, not the capability's:
 *
 * 1. Svelte `$state` reactivity: it mirrors the session's speech transitions
 *    into `state` so components and effects can read `vadRecorder.state`.
 * 2. App ties the package deliberately refuses: the recording device is read
 *    from `deviceConfig` here and passed in, and device enumeration is wrapped
 *    as local TanStack Query options.
 *
 * Usage:
 * - Access state reactively: `vadRecorder.state`
 * - Start listening: `await vadRecorder.startActiveListening({ onSpeechStart, onSpeechEnd, onVADMisfire, onLevel })`
 * - Stop listening: `await vadRecorder.stopActiveListening()`
 * - Enumerate devices: `createQuery(() => vadRecorder.enumerateDevices.options)`
 */
function createReactiveVadRecorder() {
	// The SPA is mounted below Epicenter's shared origin, so runtime asset fetches
	// must stay below the Whispering base too.
	const vad = createVadRecorder({
		assetBaseUrl: `${WHISPERING_BASE_PATHNAME}/vad/`,
	});
	let _state = $state<VadState>('IDLE');

	return {
		/**
		 * Current VAD state. Reactive: reading this in an $effect will cause the
		 * effect to re-run when the state changes.
		 */
		get state(): VadState {
			return _state;
		},

		/**
		 * Enumerate available audio input devices.
		 *
		 * Usage:
		 * - With createQuery: `createQuery(() => vadRecorder.enumerateDevices.options)`
		 */
		enumerateDevices: {
			options: resultQueryOptions({
				queryKey: vadKeys.devices,
				queryFn: async () => {
					const { data, error } = await enumerateDevices();
					if (error)
						return VadRecorderError.EnumerateDevicesFailed({ cause: error });
					return Ok(data);
				},
			}),
		},

		/**
		 * Start voice activity detection on the configured device. Updates `state`
		 * reactively as detection progresses.
		 */
		async startActiveListening(callbacks: {
			onSpeechStart: () => void;
			onSpeechEnd: (blob: Blob) => void;
			onVADMisfire: () => void;
			onLevel: (level: number) => void;
		}) {
			const configuredDeviceId = deviceConfig.get(
				'recording.navigator.deviceId',
			);
			const deviceId = configuredDeviceId
				? asDeviceIdentifier(configuredDeviceId)
				: null;

			const result = await vad.startActiveListening({
				deviceId,
				vadOptions: readVadOptions((key) => deviceConfig.get(key)),
				onLevel: callbacks.onLevel,
				// State mutations are gated on an already-armed session (`!== 'IDLE'`)
				// so a frame that arrives during the start window does not flip state
				// before listening is established, matching the core's own ordering.
				onSpeechStart: () => {
					if (_state !== 'IDLE') _state = 'SPEECH_DETECTED';
					callbacks.onSpeechStart();
				},
				onSpeechEnd: (blob) => {
					if (_state !== 'IDLE') _state = 'LISTENING';
					callbacks.onSpeechEnd(blob);
				},
				onVADMisfire: () => {
					if (_state !== 'IDLE') _state = 'LISTENING';
					callbacks.onVADMisfire();
				},
			});

			if (result.error) return result;
			_state = 'LISTENING';
			return result;
		},

		/**
		 * Stop voice activity detection and clean up resources. Sets `state` back
		 * to 'IDLE'.
		 */
		async stopActiveListening() {
			const result = await vad.stopActiveListening();
			_state = 'IDLE';
			return result;
		},
	};
}

export const vadRecorder = createReactiveVadRecorder();
