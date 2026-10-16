import type { Brand } from 'wellcrafted/brand';

/**
 * Device acquisition outcome after attempting to connect to a recording device.
 *
 * This type represents the result of device selection during recording startup.
 * All outcomes include the deviceId that was ultimately used for recording. The
 * outcome is returned to the caller as a structured fact; the consuming app owns
 * the user-facing copy that explains a fallback.
 *
 * @example
 * ```typescript
 * // Success: User's preferred device worked
 * { outcome: 'success', deviceId: 'preferred-device-id' as DeviceIdentifier }
 *
 * // Fallback: No device selected, used default
 * {
 *   outcome: 'fallback',
 *   reason: 'no-device-selected',
 *   deviceId: 'default' as DeviceIdentifier
 * }
 *
 * // Fallback: Preferred device unavailable, used alternative
 * {
 *   outcome: 'fallback',
 *   reason: 'preferred-device-unavailable',
 *   deviceId: 'default' as DeviceIdentifier
 * }
 * ```
 */
export type DeviceAcquisitionOutcome =
	| {
			outcome: 'success';
			deviceId: DeviceIdentifier;
	  }
	| {
			outcome: 'fallback';
			reason: 'no-device-selected' | 'preferred-device-unavailable';
			deviceId: DeviceIdentifier;
	  };

/**
 * Browser microphone device identifier from the Navigator API.
 *
 * This is the unique `deviceId` from `MediaDeviceInfo`, such as "default" or a
 * browser-generated ID. It is not the device label. The branded type keeps
 * persisted device choices from collapsing into arbitrary strings.
 *
 * @example
 * const deviceIdentifier: DeviceIdentifier = "8a7b9c..." as DeviceIdentifier;
 */
export type DeviceIdentifier = string & Brand<'DeviceIdentifier'>;

/**
 * Cast a string to the branded `DeviceIdentifier` type. Use this when adopting
 * device identifiers from external sources, such as settings or the Navigator
 * API.
 * @see DeviceIdentifier
 */
export function asDeviceIdentifier(value: string): DeviceIdentifier {
	return value as DeviceIdentifier;
}
