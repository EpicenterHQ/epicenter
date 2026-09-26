/**
 * Transcription Target Tests
 *
 * Verifies the Audio-stage locality rules the Processing surface reports.
 *
 * Key behaviors:
 * - The local runtime transcribes in-process and never leaves the device
 * - Locality follows the resolved endpoint host (loopback), not the provider's
 *   `location` label, so a self-hosted or cloud endpoint at localhost is on-device
 * - A remote self-hosted server reads as the user's own server, not a cloud vendor
 * - A session (Epicenter) bonded at a loopback base URL is this machine, so audio
 *   stays on-device; a remote base URL reads as sent to Epicenter
 */
import { describe, expect, test } from 'bun:test';
import type { DeviceConfigKey } from '../state/device-config.svelte';
import { describeTranscriptionDestinationFromConfig } from './transcription-target';

function config(values: Partial<Record<DeviceConfigKey, string>>) {
	return (key: DeviceConfigKey) => values[key] ?? '';
}

const REMOTE_SESSION_BASE_URL = 'https://api.epicenter.so';

describe('describeTranscriptionDestinationFromConfig', () => {
	test('local runtime keeps audio on device', () => {
		expect(
			describeTranscriptionDestinationFromConfig({
				service: 'local',
				getDeviceConfig: config({}),
				sessionBaseUrl: REMOTE_SESSION_BASE_URL,
			}),
		).toEqual({ onDevice: true, summary: 'Audio stays on this device.' });
	});

	test('cloud provider without an override names itself as the destination', () => {
		expect(
			describeTranscriptionDestinationFromConfig({
				service: 'OpenAI',
				getDeviceConfig: config({}),
				sessionBaseUrl: REMOTE_SESSION_BASE_URL,
			}),
		).toEqual({ onDevice: false, summary: 'Audio is sent to OpenAI.' });
	});

	test('cloud provider overridden to localhost keeps audio on device', () => {
		expect(
			describeTranscriptionDestinationFromConfig({
				service: 'OpenAI',
				getDeviceConfig: config({
					'providers.openai.endpoint': 'http://localhost:1234/v1',
				}),
				sessionBaseUrl: REMOTE_SESSION_BASE_URL,
			}),
		).toEqual({ onDevice: true, summary: 'Audio stays on this device.' });
	});

	test('self-hosted server at loopback keeps audio on device', () => {
		expect(
			describeTranscriptionDestinationFromConfig({
				service: 'speaches',
				getDeviceConfig: config({
					'providers.speaches.endpoint': 'http://localhost:8000',
				}),
				sessionBaseUrl: REMOTE_SESSION_BASE_URL,
			}),
		).toEqual({ onDevice: true, summary: 'Audio stays on this device.' });
	});

	test('self-hosted server at a remote host reads as the user own server', () => {
		expect(
			describeTranscriptionDestinationFromConfig({
				service: 'speaches',
				getDeviceConfig: config({
					'providers.speaches.endpoint': 'https://speaches.mybox.example',
				}),
				sessionBaseUrl: REMOTE_SESSION_BASE_URL,
			}),
		).toEqual({
			onDevice: false,
			summary: 'Audio is sent to your Speaches server.',
		});
	});

	test('unconfigured self-hosted server still reads as the user own server', () => {
		expect(
			describeTranscriptionDestinationFromConfig({
				service: 'speaches',
				getDeviceConfig: config({}),
				sessionBaseUrl: REMOTE_SESSION_BASE_URL,
			}),
		).toEqual({
			onDevice: false,
			summary: 'Audio is sent to your Speaches server.',
		});
	});

	test('compatible endpoint at loopback keeps audio on device', () => {
		expect(
			describeTranscriptionDestinationFromConfig({
				service: 'openai-compatible',
				getDeviceConfig: config({
					'providers.openaiCompatible.endpoint': 'http://localhost:8787/v1',
				}),
				sessionBaseUrl: REMOTE_SESSION_BASE_URL,
			}),
		).toEqual({ onDevice: true, summary: 'Audio stays on this device.' });
	});

	test('compatible endpoint at a remote host reads as the user own server', () => {
		expect(
			describeTranscriptionDestinationFromConfig({
				service: 'openai-compatible',
				getDeviceConfig: config({
					'providers.openaiCompatible.endpoint':
						'https://gateway.example.com/v1',
				}),
				sessionBaseUrl: REMOTE_SESSION_BASE_URL,
			}),
		).toEqual({
			onDevice: false,
			summary: 'Audio is sent to your OpenAI-compatible server.',
		});
	});

	test('session bonded at a loopback base URL keeps audio on device', () => {
		expect(
			describeTranscriptionDestinationFromConfig({
				service: 'epicenter',
				getDeviceConfig: config({}),
				sessionBaseUrl: 'http://localhost:8788',
			}),
		).toEqual({ onDevice: true, summary: 'Audio stays on this device.' });
	});

	test('session bonded at a remote base URL is sent to Epicenter', () => {
		expect(
			describeTranscriptionDestinationFromConfig({
				service: 'epicenter',
				getDeviceConfig: config({}),
				sessionBaseUrl: REMOTE_SESSION_BASE_URL,
			}),
		).toEqual({ onDevice: false, summary: 'Audio is sent to Epicenter.' });
	});
});
