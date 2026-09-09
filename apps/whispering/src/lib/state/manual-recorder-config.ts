import { asDeviceIdentifier } from '@epicenter/recorder';
import type { RecordingParams } from '@epicenter/recorder/recording';
import { deviceConfig } from '$lib/state/device-config.svelte';

/** Device identifiers belong to the capture implementation that issued them. */
export function createManualRecorderConfig(
	key: 'recording.cpal.deviceId' | 'recording.navigator.deviceId',
) {
	return {
		get deviceId(): string | null {
			return deviceConfig.get(key);
		},
		set deviceId(value: string | null) {
			deviceConfig.set(key, value);
		},
		resolveStartParams(): RecordingParams {
			const deviceId = this.deviceId;
			return {
				selectedDeviceId: deviceId ? asDeviceIdentifier(deviceId) : null,
			};
		},
	};
}
