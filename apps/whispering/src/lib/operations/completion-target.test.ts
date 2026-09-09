/** Saved provider settings are an explicit setup source, never runtime routing. */
import { describe, expect, test } from 'bun:test';
import type { InferenceProviderId } from '../constants/inference';
import {
	type CompletionState,
	type InferenceConfigKey,
	resolveCompletionStateFromConfig,
} from './completion-target';

function config(values: Partial<Record<InferenceConfigKey, string>>) {
	return (key: InferenceConfigKey) => values[key] ?? '';
}

function state(
	provider: InferenceProviderId,
	values: Partial<Record<InferenceConfigKey, string>>,
): CompletionState {
	return resolveCompletionStateFromConfig({
		provider,
		getDeviceConfig: config(values),
	});
}

describe('saved completion setup', () => {
	test('endpoint override beats the provider default', () => {
		expect(
			state('OpenAI', {
				'providers.openai.endpoint': ' https://proxy.example/v1 ',
				'providers.openai.apiKey': ' sk-test ',
			}),
		).toEqual({
			target: { baseUrl: 'https://proxy.example/v1', apiKey: 'sk-test' },
			canRun: true,
		});
	});

	test('Custom without an endpoint has no completion target and cannot run', () => {
		expect(state('Custom', {})).toEqual({
			target: null,
			canRun: false,
		});
	});

	test('keyless Custom loopback endpoint can serve local Polish', () => {
		expect(
			state('Custom', {
				'providers.custom.endpoint': 'http://localhost:11434/v1',
			}),
		).toEqual({
			target: { baseUrl: 'http://localhost:11434/v1', apiKey: undefined },
			canRun: true,
		});
	});

	test('cloud provider without a key cannot serve Polish', () => {
		expect(state('Google', {})).toEqual({
			target: {
				baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
				apiKey: undefined,
			},
			canRun: false,
		});
	});

	test('cloud provider endpoint override to localhost with no key runs without a provider key', () => {
		expect(
			state('OpenAI', {
				'providers.openai.endpoint': 'http://localhost:1234/v1',
			}),
		).toEqual({
			target: { baseUrl: 'http://localhost:1234/v1', apiKey: undefined },
			canRun: true,
		});
	});

	test('loopback endpoint preserves a configured key', () => {
		expect(
			state('Custom', {
				'providers.custom.endpoint': 'http://127.0.0.1:11434/v1',
				'providers.custom.apiKey': 'local-key',
			}),
		).toEqual({
			target: { baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'local-key' },
			canRun: true,
		});
	});
});
