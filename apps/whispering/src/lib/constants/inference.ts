import type {
	DeviceConfigKey,
	SecretKey,
} from '$lib/state/device-config.svelte';
import {
	INFERENCE_PROVIDER_IDS,
	type InferenceProviderId,
} from './inference-provider-ids';

export {
	INFERENCE_PROVIDER_IDS,
	type InferenceProviderId,
} from './inference-provider-ids';

type InferenceProvider = {
	label: string;
	/**
	 * Canonical OpenAI-compatible base URL this provider's completions run
	 * against, or null when the user must supply it (Custom). Anthropic and Google
	 * point at their OpenAI-compatibility endpoints (ADR-0060), so every provider
	 * speaks one wire and completion has a single code path with no per-provider
	 * client. An endpoint override in deviceConfig still wins over this default.
	 */
	defaultBaseUrl: string | null;
	/** Fixed model list, or null when the model is typed free-form (OpenRouter, Custom). */
	models: readonly string[] | null;
	/**
	 * The provider's API key: a secret, so it routes through the credential facade
	 * (`secrets.get`), not raw `deviceConfig`. `SecretKey` (not the wider
	 * `DeviceConfigKey`) makes that structural, per ADR-0074.
	 */
	apiKeyConfigKey: SecretKey;
	/** Device config key for the endpoint override; null when not configurable. */
	endpointConfigKey: DeviceConfigKey | null;
};

/**
 * Single source of truth for inference providers: their models, labels, the
 * deviceConfig key NAMES holding each provider's credential and endpoint override,
 * and the canonical base URL each provider's completions run against. SDK-free
 * (only a type import), so the data Lens imports it without bundling any
 * provider client. This is the completion twin of transcription's `PROVIDERS`:
 * every provider speaks the OpenAI completion wire (Anthropic and Google through
 * their OpenAI-compatibility endpoints), so a completion resolves a
 * `{ baseUrl, apiKey? }` connection from this table and hands it to one
 * `complete()` call: no per-provider dispatch, no bespoke client.
 *
 * Access patterns:
 * - Provider IDs:  `keyof typeof INFERENCE` → 'OpenAI' | 'Groq' | ...
 * - Models:        `INFERENCE.OpenAI.models` → readonly ['gpt-5', ...]
 * - Labels:        `INFERENCE.OpenAI.label` → 'OpenAI'
 * - Config keys:   `INFERENCE.OpenAI.apiKeyConfigKey` → 'providers.openai.apiKey'
 * - Enumerate:     `Object.keys(INFERENCE)` / `Object.entries(INFERENCE)`
 * - Schema:        `type.enumerated(...INFERENCE.OpenAI.models)`
 */
export const INFERENCE = {
	OpenAI: {
		label: 'OpenAI',
		defaultBaseUrl: 'https://api.openai.com/v1',
		apiKeyConfigKey: 'providers.openai.apiKey',
		endpointConfigKey: 'providers.openai.endpoint',
		models: [
			'gpt-5',
			'gpt-5-mini',
			'gpt-4.1',
			'gpt-4.1-mini',
			'gpt-4.1-nano',
			'gpt-4o',
			'gpt-4o-mini',
			'o3',
			'o3-pro',
			'o3-mini',
			'o4-mini',
		],
	},
	Groq: {
		label: 'Groq',
		defaultBaseUrl: 'https://api.groq.com/openai/v1',
		apiKeyConfigKey: 'providers.groq.apiKey',
		endpointConfigKey: 'providers.groq.endpoint',
		models: [
			// Production models
			'gemma2-9b-it',
			'meta-llama/llama-guard-4-12b',
			'llama-3.3-70b-versatile',
			'llama-3.1-8b-instant',
			// Preview models
			'deepseek-r1-distill-llama-70b',
			'meta-llama/llama-4-maverick-17b-128e-instruct',
			'meta-llama/llama-4-scout-17b-16e-instruct',
			'meta-llama/llama-prompt-guard-2-22m',
			'meta-llama/llama-prompt-guard-2-86m',
			'mistral-saba-24b',
			'qwen-qwq-32b',
			'qwen/qwen3-32b',
		],
	},
	Anthropic: {
		label: 'Anthropic',
		defaultBaseUrl: 'https://api.anthropic.com/v1',
		apiKeyConfigKey: 'providers.anthropic.apiKey',
		endpointConfigKey: null,
		models: [
			// Claude 4.5 models (latest generation - recommended)
			'claude-sonnet-4-5-20250929',
			'claude-sonnet-4-5',
			'claude-haiku-4-5-20251001',
			'claude-haiku-4-5',
			'claude-opus-4-1-20250805',
			'claude-opus-4-1',
			// Claude 4 models (legacy but still available)
			'claude-sonnet-4-20250514',
			'claude-sonnet-4-0',
			'claude-opus-4-20250514',
			'claude-opus-4-0',
			// Claude 3.7 models (legacy)
			'claude-3-7-sonnet-20250219',
			'claude-3-7-sonnet-latest',
			// Claude 3.5 models (legacy)
			'claude-3-5-haiku-20241022',
			'claude-3-5-haiku-latest',
			// Claude 3 models (legacy)
			'claude-3-haiku-20240307',
		],
	},
	Google: {
		label: 'Google',
		defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
		apiKeyConfigKey: 'providers.google.apiKey',
		endpointConfigKey: null,
		models: [
			'gemini-2.5-pro',
			'gemini-2.5-flash',
			'gemini-2.5-flash-lite-preview-06-17',
			'gemini-pro-latest',
			'gemini-flash-latest',
			'gemini-flash-lite-latest',
		],
	},
	OpenRouter: {
		label: 'OpenRouter',
		defaultBaseUrl: 'https://openrouter.ai/api/v1',
		apiKeyConfigKey: 'providers.openrouter.apiKey',
		endpointConfigKey: null,
		models: null,
	},
	Custom: {
		label: 'Custom (OpenAI-compatible)',
		defaultBaseUrl: null,
		apiKeyConfigKey: 'providers.custom.apiKey',
		endpointConfigKey: 'providers.custom.endpoint',
		models: null,
	},
} as const satisfies Record<InferenceProviderId, InferenceProvider>;

/**
 * Inference providers with a fixed model list (`models` is non-null), i.e.
 * the ones whose model is picked from a select instead of typed free-form.
 */
export type ModelSelectProviderId = {
	[K in InferenceProviderId]: (typeof INFERENCE)[K]['models'] extends null
		? never
		: K;
}[InferenceProviderId];

/** Narrow a provider to one whose model comes from a fixed list. */
export const hasModelSelect = (
	provider: InferenceProviderId,
): provider is ModelSelectProviderId => INFERENCE[provider].models !== null;

/** UI dropdown options for provider selection. */
export const INFERENCE_PROVIDER_OPTIONS = INFERENCE_PROVIDER_IDS.map((id) => ({
	value: id,
	label: INFERENCE[id].label,
}));
