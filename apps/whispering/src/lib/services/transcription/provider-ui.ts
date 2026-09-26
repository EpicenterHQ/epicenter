/**
 * UI-facing provider data: the icons plus the `TRANSCRIPTION_PROVIDERS` join.
 * Kept out of `providers.ts` so the workspace schema can import
 * `TRANSCRIPTION_SERVICE_IDS` without bundling these `?raw` SVGs.
 * `TRANSCRIPTION_PROVIDERS` is the join of each provider's data with its icon:
 * an array (id + every provider field + icon) that the settings selectors
 * iterate and filter by `access`.
 */
import deepgramIcon from '$lib/constants/icons/deepgram.svg?raw';
import elevenlabsIcon from '$lib/constants/icons/elevenlabs.svg?raw';
import epicenterIcon from '$lib/constants/icons/epicenter.svg?raw';
import ggmlIcon from '$lib/constants/icons/ggml.svg?raw';
import groqIcon from '$lib/constants/icons/groq.svg?raw';
import mistralIcon from '$lib/constants/icons/mistral.svg?raw';
import openaiIcon from '$lib/constants/icons/openai.svg?raw';
import serverIcon from '$lib/constants/icons/server.svg?raw';
import speachesIcon from '$lib/constants/icons/speaches.svg?raw';
import {
	PROVIDERS,
	type ProviderAccess,
	type TranscriptionServiceId,
} from './providers';

export const PROVIDER_ICONS = {
	epicenter: { icon: epicenterIcon, invertInDarkMode: false },
	OpenAI: { icon: openaiIcon, invertInDarkMode: true },
	Groq: { icon: groqIcon, invertInDarkMode: false },
	ElevenLabs: { icon: elevenlabsIcon, invertInDarkMode: true },
	Deepgram: { icon: deepgramIcon, invertInDarkMode: true },
	Mistral: { icon: mistralIcon, invertInDarkMode: false },
	local: { icon: ggmlIcon, invertInDarkMode: true },
	speaches: { icon: speachesIcon, invertInDarkMode: false },
	'openai-compatible': { icon: serverIcon, invertInDarkMode: true },
} as const satisfies Record<
	TranscriptionServiceId,
	{ icon: string; invertInDarkMode: boolean }
>;

/**
 * One provider's registry data joined with its icon, discriminated by id:
 * narrowing on `access` (or `id`) narrows every field together, `id`
 * included. A plain `Object.entries(...).map(...)` type would cross the full
 * id union with the full provider union, so narrowing `access` would leave
 * `id` broad; the mapped type keeps each id paired with its own shape.
 */
export type TranscriptionProviderEntry = {
	[K in TranscriptionServiceId]: { id: K } & (typeof PROVIDERS)[K] &
		(typeof PROVIDER_ICONS)[K];
}[TranscriptionServiceId];

/** UI-facing list: each provider's data joined with its icon, in declaration order. */
export const TRANSCRIPTION_PROVIDERS = (
	Object.entries(PROVIDERS) as [
		TranscriptionServiceId,
		(typeof PROVIDERS)[TranscriptionServiceId],
	][]
).map(([id, provider]) => ({
	id,
	...provider,
	...PROVIDER_ICONS[id],
})) as TranscriptionProviderEntry[];

/**
 * The single source of how each `access` family is presented: the section heading
 * the setup catalog shows and the short badge it tags each family with. Declaration
 * order is display order, so the setup catalog renders on-device first
 * (privacy-forward, matching the recorder switcher's `[...onDevice, ...remote]`),
 * then Epicenter, then keyed providers, then a custom server. `satisfies
 * Record<ProviderAccess, ...>` makes a new access member a compile error here, so a
 * family can never be silently dropped from the catalog the way `session` once was.
 * Group *membership* lives in the registry (`access`); this map owns only presentation.
 */
export const ACCESS_GROUPS = {
	onDevice: { heading: 'On your device', badge: 'Local' },
	session: { heading: 'Epicenter', badge: 'Hosted' },
	key: { heading: 'Provider API', badge: 'API' },
	endpoint: { heading: 'Custom server', badge: 'Self-Hosted' },
} as const satisfies Record<ProviderAccess, { heading: string; badge: string }>;
