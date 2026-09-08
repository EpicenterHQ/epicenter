/**
 * The single source of truth for transcription providers. One entry per
 * provider owns every fact: label, access, models, capabilities, and the
 * deviceConfig/settings key NAMES used to read its config (never the values,
 * which the dispatcher in `operations/transcribe.ts` reads).
 *
 * Pointer-field naming: the suffix names the store. A `*ConfigKey` field
 * holds the name of a `deviceConfig` entry (device-local, never synced); a
 * `*SettingKey` field holds the name of a `settings` entry (synced workspace
 * KV). Dispatchers resolve the pointer against the matching store.
 *
 * Behavior is deliberately not here. The `id -> transcribe` wiring lives as a
 * static table in the dispatcher, where the provider SDKs already load. That
 * keeps this record free of SDK imports so the workspace schema can import
 * `TRANSCRIPTION_SERVICE_IDS` without bundling them. Icons and the UI-facing
 * join live in `./provider-ui.ts` (icons being the one field heavy enough to
 * pollute that import).
 */
import type {
	DeviceConfigKey,
	SecretKey,
} from '$lib/state/device-config.svelte';
import type { TranscriptionServiceId } from './provider-ids';

export {
	TRANSCRIPTION_SERVICE_IDS,
	type TranscriptionServiceId,
} from './provider-ids';

type Capabilities = { supportsPrompt: boolean; supportsLanguage: boolean };
type CloudModel = { name: string; description: string; cost: string };

/**
 * `access` is the per-family discriminant every dispatcher, selector, and readiness
 * check branches on. Each member names what the user supplies to make a provider
 * usable, so it maps one-to-one to what `isTranscriptionServiceConfigured` reads:
 *
 *   - `key`      the user's own API key (a secret)         -> OpenAI, Groq, ...
 *   - `endpoint` a server URL + model id the user runs     -> Speaches
 *   - `session`  a signed-in session; the Epicenter        -> Epicenter
 *                deployment you are bonded to is the key
 *   - `onDevice` nothing but the device: an on-device       -> Local
 *                model file, no network
 *
 * `key` and `endpoint` are the matched pair: both hand a `{ baseUrl, apiKey? }` to
 * an external OpenAI-compatible box, differing only in whether the user brings a
 * key (the vendor's compute) or an endpoint (their own box). `session` is the
 * platform relationship: it follows the STAR-vs-SERVICES split (ADR-0068/0069/0070),
 * reaching the Epicenter deployment that also holds your synced data over your
 * session, on that deployment's house key. Hosted deployments meter it (AI credits);
 * self-host deployments proxy it unmetered. `key`/`endpoint` are external services.
 */
export type ProviderAccess = 'key' | 'endpoint' | 'session' | 'onDevice';

type KeyProvider = {
	access: Extract<ProviderAccess, 'key'>;
	label: string;
	description: string;
	capabilities: Capabilities;
	models: readonly CloudModel[];
	defaultModel: string;
	/**
	 * The provider's API key: a secret, so it routes through the credential
	 * facade (`secrets.get`), not raw `deviceConfig`. `SecretKey` (not the wider
	 * `DeviceConfigKey`) makes that structural, per ADR-0074.
	 */
	apiKeyConfigKey: SecretKey;
	/**
	 * The settings key holding this provider's model selection. Constrained to
	 * the shape `transcription<Provider>Model` rather than a precise union of
	 * the cloud keys: a precise union here would make `typeof PROVIDERS`
	 * reference a type derived from itself (`satisfies Record<...>` closes the
	 * loop). The real guard is the call site `settings.get(modelSettingKey)`,
	 * which rejects a key the workspace does not declare.
	 */
	modelSettingKey: `transcription${string}Model`;
	/** Device config key for the endpoint override; null when not configurable. */
	endpointConfigKey: DeviceConfigKey | null;
	/**
	 * Where this provider documents its transcription models; null when the
	 * provider has no good page to link. The settings page renders this under
	 * the model picker.
	 */
	modelsDoc: { label: string; href: string } | null;
};

type OnDeviceProvider = {
	access: Extract<ProviderAccess, 'onDevice'>;
	label: string;
	description: string;
	// No model pointer and no static `capabilities`: the host owns the one
	// active local model (ADR-0180), and its per-model capability is read from
	// that model at use, not declared provider-wide the way a cloud family's is.
};

type EndpointProvider = {
	access: Extract<ProviderAccess, 'endpoint'>;
	label: string;
	description: string;
	capabilities: Capabilities;
	endpointConfigKey: DeviceConfigKey;
	modelIdConfigKey: DeviceConfigKey;
};

/**
 * The `session` access member: transcription through the Epicenter deployment
 * (the platform "star", ADR-0068/0069/0070) this install is bonded to. Unlike a
 * `key` provider it carries no key or endpoint config; the transport is the
 * signed-in session's audience-scoped fetch (`account.fetch`), resolved in the
 * dispatcher against `auth.connection.baseURL` (the hosted cloud by default, or a self-host
 * instance if the user pointed there), and the gateway pins its own house model
 * server-side (ADR-0100). So the only fact this entry holds is the single `model`
 * string the wire requires. "Configured" means signed in, not "has a key" (see
 * `transcription-validation.ts`).
 *
 * The same `/v1/audio/transcriptions` gateway runs on every deployment (both
 * deployables mount it on the deployment's house key), so this is deployment-neutral.
 * Whether a call spends AI credits is a property of the deployment, surfaced at
 * runtime: a hosted deployment meters it (402 when out of credits); a self-host
 * deployment proxies it unmetered (or 503 until the operator sets a house key).
 * Never fixed here.
 */
type SessionProvider = {
	access: Extract<ProviderAccess, 'session'>;
	label: string;
	description: string;
	capabilities: Capabilities;
	/** The fixed model sent on the wire; the gateway meters by duration, not by
	 *  model, so there is no user-selectable list. */
	model: string;
};

type TranscriptionProvider =
	| KeyProvider
	| OnDeviceProvider
	| EndpointProvider
	| SessionProvider;

export const PROVIDERS = {
	epicenter: {
		access: 'session',
		label: 'Epicenter',
		description:
			'Transcription through your connected Epicenter. Sign in required.',
		capabilities: { supportsPrompt: true, supportsLanguage: true },
		model: 'whisper-1',
	},
	OpenAI: {
		access: 'key',
		label: 'OpenAI',
		description: 'Industry-standard Whisper API',
		capabilities: { supportsPrompt: true, supportsLanguage: true },
		apiKeyConfigKey: 'providers.openai.apiKey',
		modelSettingKey: 'transcriptionOpenaiModel',
		endpointConfigKey: 'providers.openai.endpoint',
		modelsDoc: {
			label: 'OpenAI docs',
			href: 'https://platform.openai.com/docs/guides/speech-to-text',
		},
		defaultModel: 'whisper-1',
		models: [
			{
				name: 'whisper-1',
				description:
					"OpenAI's flagship speech-to-text model with multilingual support. Reliable and accurate transcription for a wide variety of use cases.",
				cost: '$0.36/hour',
			},
			{
				name: 'gpt-4o-transcribe',
				description:
					'GPT-4o powered transcription with enhanced understanding and context. Best for complex audio requiring deep comprehension.',
				cost: '$0.36/hour',
			},
			{
				name: 'gpt-4o-mini-transcribe',
				description:
					'Cost-effective GPT-4o mini transcription model. Good balance of performance and cost for standard transcription needs.',
				cost: '$0.18/hour',
			},
		],
	},
	Groq: {
		access: 'key',
		label: 'Groq',
		description: 'Lightning-fast cloud transcription',
		capabilities: { supportsPrompt: true, supportsLanguage: true },
		apiKeyConfigKey: 'providers.groq.apiKey',
		modelSettingKey: 'transcriptionGroqModel',
		endpointConfigKey: 'providers.groq.endpoint',
		modelsDoc: {
			label: 'Groq docs',
			href: 'https://console.groq.com/docs/speech-to-text',
		},
		defaultModel: 'whisper-large-v3-turbo',
		models: [
			{
				name: 'whisper-large-v3',
				description:
					'Best accuracy (10.3% WER) and full multilingual support, including translation. Recommended for error-sensitive applications requiring multilingual support.',
				cost: '$0.111/hour',
			},
			{
				name: 'whisper-large-v3-turbo',
				description:
					'Fast multilingual model with good accuracy (12% WER). Best price-to-performance ratio for multilingual applications.',
				cost: '$0.04/hour',
			},
		],
	},
	ElevenLabs: {
		access: 'key',
		label: 'ElevenLabs',
		description: 'Voice AI platform with transcription',
		capabilities: { supportsPrompt: true, supportsLanguage: true },
		apiKeyConfigKey: 'providers.elevenlabs.apiKey',
		endpointConfigKey: null,
		modelSettingKey: 'transcriptionElevenlabsModel',
		modelsDoc: {
			label: 'ElevenLabs docs',
			href: 'https://elevenlabs.io/docs/capabilities/speech-to-text',
		},
		defaultModel: 'scribe_v2',
		models: [
			{
				name: 'scribe_v2',
				description:
					'Latest flagship transcription model with 97% accuracy. Features speaker diarization (up to 48 speakers), entity detection, keyterm prompting, and dynamic audio tagging across 90+ languages.',
				cost: '$0.40/hour',
			},
			{
				name: 'scribe_v1',
				description:
					'Previous generation transcription model with 96.7% accuracy for English. Supports 99 languages with word-level timestamps and speaker diarization.',
				cost: '$0.40/hour',
			},
			{
				name: 'scribe_v1_experimental',
				description:
					'Experimental version of Scribe with latest features and improvements. May include cutting-edge capabilities but with potential instability.',
				cost: '$0.40/hour',
			},
		],
	},
	Deepgram: {
		access: 'key',
		label: 'Deepgram',
		description: 'Real-time speech recognition API',
		capabilities: { supportsPrompt: true, supportsLanguage: true },
		apiKeyConfigKey: 'providers.deepgram.apiKey',
		endpointConfigKey: null,
		modelSettingKey: 'transcriptionDeepgramModel',
		modelsDoc: null,
		defaultModel: 'nova-3',
		models: [
			{
				name: 'nova-3',
				description:
					"Deepgram's most advanced speech-to-text model with superior accuracy and speed. Best for high-quality transcription needs.",
				cost: '$0.0043/minute',
			},
			{
				name: 'nova-2',
				description: "Deepgram's previous best speech-to-text model.",
				cost: '$0.0043/minute',
			},
			{
				name: 'nova',
				description:
					'Deepgram Nova model with excellent accuracy and performance. Good balance of speed and quality.',
				cost: '$0.0043/minute',
			},
			{
				name: 'enhanced',
				description:
					'Enhanced general-purpose model with good accuracy for most use cases. Cost-effective option.',
				cost: '$0.0025/minute',
			},
			{
				name: 'base',
				description:
					'Base model for standard transcription needs. Most cost-effective option with reasonable accuracy.',
				cost: '$0.0020/minute',
			},
		],
	},
	Mistral: {
		access: 'key',
		label: 'Mistral AI',
		description: 'Advanced Voxtral speech understanding',
		capabilities: { supportsPrompt: true, supportsLanguage: true },
		apiKeyConfigKey: 'providers.mistral.apiKey',
		endpointConfigKey: null,
		modelSettingKey: 'transcriptionMistralModel',
		modelsDoc: {
			label: 'Mistral docs',
			href: 'https://mistral.ai/news/voxtral/',
		},
		defaultModel: 'voxtral-mini-latest',
		models: [
			{
				name: 'voxtral-mini-latest',
				description:
					'API-optimized Voxtral Mini model delivering unparalleled cost and latency efficiency. Supports multilingual transcription with high accuracy.',
				cost: '$0.12/hour',
			},
			{
				name: 'voxtral-small-latest',
				description:
					'Voxtral Small model for higher accuracy and broader language support. Suitable for most transcription needs with a balance of cost and performance.',
				cost: '$0.24/hour',
			},
		],
	},

	local: {
		access: 'onDevice',
		label: 'Local',
		description: 'Private on-device transcription, no internet required',
	},

	speaches: {
		access: 'endpoint',
		label: 'Speaches',
		description: 'Self-hosted transcription server',
		capabilities: { supportsPrompt: true, supportsLanguage: true },
		endpointConfigKey: 'providers.speaches.endpoint',
		modelIdConfigKey: 'providers.speaches.modelId',
	},
} as const satisfies Record<TranscriptionServiceId, TranscriptionProvider>;

/**
 * The ids of `key` providers (the ones that take a user API key), derived from
 * PROVIDERS. Consumed by the settings UI to type provider config fields.
 * (Transcription routing no longer keys off this: `operations/transcribe.ts`
 * dispatches over a single `UPLOAD_DISPATCH` table that excludes only the
 * on-device ids.)
 */
export type KeyProviderId = {
	[K in TranscriptionServiceId]: (typeof PROVIDERS)[K]['access'] extends 'key'
		? K
		: never;
}[TranscriptionServiceId];

/**
 * The ids of on-device providers, derived the same way. Today this is the
 * single local GGUF runtime; `isOnDeviceProviderId` is the one narrowing
 * boundary callers use before reading on-device-only fields like the selected
 * model's catalog id.
 */
export type OnDeviceProviderId = {
	[K in TranscriptionServiceId]: (typeof PROVIDERS)[K]['access'] extends 'onDevice'
		? K
		: never;
}[TranscriptionServiceId];

export function isOnDeviceProviderId(
	id: TranscriptionServiceId,
): id is OnDeviceProviderId {
	return PROVIDERS[id].access === 'onDevice';
}

/**
 * The upload providers: every non-on-device id, reached by uploading audio over the
 * wire (key, endpoint, session) rather than the on-device FFI path. "Upload" is
 * "not on-device", and on-device-ness is the one facet PROVIDERS declares, so the
 * subtraction reads as English. `UPLOAD_DISPATCH` is keyed by exactly this set.
 */
export type UploadProviderId = Exclude<
	TranscriptionServiceId,
	OnDeviceProviderId
>;
