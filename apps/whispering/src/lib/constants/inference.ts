import type {
	DeviceConfigKey,
	SecretKey,
} from '$lib/state/device-config.svelte';
import type { InferenceProviderId } from './inference-provider-ids';

export {
	INFERENCE_PROVIDER_IDS,
	type InferenceProviderId,
} from './inference-provider-ids';

/** Saved provider fields can seed an explicit connection selection. */
type InferenceProvider = {
	label: string;
	defaultBaseUrl: string | null;
	apiKeyConfigKey: SecretKey;
	endpointConfigKey: DeviceConfigKey | null;
};

/** Previous completion setup; execution reads the connection registry instead. */
export const INFERENCE = {
	OpenAI: {
		label: 'OpenAI',
		defaultBaseUrl: 'https://api.openai.com/v1',
		apiKeyConfigKey: 'providers.openai.apiKey',
		endpointConfigKey: 'providers.openai.endpoint',
	},
	Groq: {
		label: 'Groq',
		defaultBaseUrl: 'https://api.groq.com/openai/v1',
		apiKeyConfigKey: 'providers.groq.apiKey',
		endpointConfigKey: 'providers.groq.endpoint',
	},
	Anthropic: {
		label: 'Anthropic',
		defaultBaseUrl: 'https://api.anthropic.com/v1',
		apiKeyConfigKey: 'providers.anthropic.apiKey',
		endpointConfigKey: null,
	},
	Google: {
		label: 'Google',
		defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
		apiKeyConfigKey: 'providers.google.apiKey',
		endpointConfigKey: null,
	},
	OpenRouter: {
		label: 'OpenRouter',
		defaultBaseUrl: 'https://openrouter.ai/api/v1',
		apiKeyConfigKey: 'providers.openrouter.apiKey',
		endpointConfigKey: null,
	},
	Custom: {
		label: 'Custom (OpenAI-compatible)',
		defaultBaseUrl: null,
		apiKeyConfigKey: 'providers.custom.apiKey',
		endpointConfigKey: 'providers.custom.endpoint',
	},
} as const satisfies Record<InferenceProviderId, InferenceProvider>;
