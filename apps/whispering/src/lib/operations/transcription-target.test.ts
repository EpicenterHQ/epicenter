/**
 * Transcription destination tests: native execution is scoped to transcription,
 * HTTP destinations never imply private inference, and Epicenter keeps its name
 * independently of the gateway address. Backup is not inferred from routing.
 */
import { expect, test } from 'bun:test';
import { describeTranscriptionDestinationFromConfig } from './transcription-target.js';

test('native inference describes execution without promising audio never leaves', () => {
	expect(
		describeTranscriptionDestinationFromConfig({
			service: 'local',
			getDeviceConfig: () => '',
		}),
	).toBe('Transcribed on this device.');
});

test('Epicenter routing never classifies the gateway hostname as local inference', () => {
	expect(
		describeTranscriptionDestinationFromConfig({
			service: 'epicenter',
			getDeviceConfig: () => 'http://localhost:8787',
		}),
	).toBe('Transcription via Epicenter.');
});

test('HTTP endpoints name the actual host including preset overrides', () => {
	for (const service of ['OpenAI', 'speaches'] as const) {
		for (const host of ['localhost:8000', '127.0.0.1:8000', 'proxy.example']) {
			expect(
				describeTranscriptionDestinationFromConfig({
					service,
					getDeviceConfig: () => `http://${host}/v1`,
				}),
			).toBe(`Transcription via ${host}.`);
		}
	}
});

test('canonical vendor is named and missing custom endpoint asks for setup', () => {
	expect(
		describeTranscriptionDestinationFromConfig({
			service: 'OpenAI',
			getDeviceConfig: () => '',
		}),
	).toBe('Transcription via OpenAI.');
	expect(
		describeTranscriptionDestinationFromConfig({
			service: 'speaches',
			getDeviceConfig: () => '',
		}),
	).toBe('Add a transcription server URL.');
});
