import { asDeviceIdentifier } from '@epicenter/recorder';
import type { NavigatorRecordingParams } from '$lib/services/recorder/contract';
import { deviceConfig } from '$lib/state/device-config.svelte';

const MANUAL_DEVICE_ID_KEY = 'recording.navigator.deviceId';

/**
 * Platform-resolved manual recorder settings for the browser build.
 *
 * Web manual recording uses the Navigator device key, which is also the browser
 * VAD device key. This object makes the manual recorder's side of that choice
 * explicit and keeps UI, fallback persistence, and start-param resolution on
 * one build-time-resolved path.
 */
export const manualRecorderConfig = {
	get deviceId(): string | null {
		return deviceConfig.get(MANUAL_DEVICE_ID_KEY);
	},

	set deviceId(deviceId: string | null) {
		deviceConfig.set(MANUAL_DEVICE_ID_KEY, deviceId);
	},

	/**
	 * Resolve persisted manual recorder settings into Navigator start params.
	 *
	 * The recorder service stays params-in and does not read Svelte state; this
	 * config boundary performs that app-level read immediately before starting.
	 * Only settings-derived config lives here; live callbacks (the meter sink)
	 * are passed separately to `startRecording`.
	 */
	resolveStartParams(): NavigatorRecordingParams {
		const deviceId = this.deviceId;
		return {
			selectedDeviceId: deviceId ? asDeviceIdentifier(deviceId) : null,
			bitrateKbps: deviceConfig.get('recording.navigator.bitrateKbps'),
		};
	},
};
