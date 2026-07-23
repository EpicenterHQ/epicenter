import {
	type ResolvedConnection,
	resolveConnection,
	transcribe,
} from '@epicenter/client';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import { type AnyTaggedError, defineErrors } from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import { auth } from '#platform/auth';
import { customFetch } from '#platform/http';
import { tauri } from '#platform/tauri';
import type { SupportedLanguage } from '$lib/constants/languages';
import type { RecordingId } from '$lib/data';
import { logAnalyticsEvent } from '$lib/operations/analytics';
import {
	recordTranscriptionOutcome,
	type TranscriptionSuccess,
} from '$lib/operations/transcription-history';
import { report } from '$lib/report';
import { DeepgramTranscriptionServiceLive } from '$lib/services/transcription/cloud/deepgram';
import { ElevenLabsTranscriptionServiceLive } from '$lib/services/transcription/cloud/elevenlabs';
import { MistralTranscriptionServiceLive } from '$lib/services/transcription/cloud/mistral';
import {
	isOnDeviceProviderId,
	type OnDeviceProviderId,
	PROVIDERS,
	type UploadProviderId,
} from '$lib/services/transcription/providers';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { type SecretKey, secrets } from '$lib/state/secrets.svelte';
import type { WhisperingApp } from '$lib/whispering/app';

/**
 * The error any transcription path can surface. Deliberately `AnyTaggedError`
 * rather than the concrete provider-error union: every consumer (toast,
 * failed-row tooltip, practice view, analytics) presents these by `.message`,
 * and none discriminate on `.name`. The user-facing message is curated where
 * the context lives, in each service's `defineErrors` constructors, so this
 * boundary only needs to promise `{ name, message }`. Widening to the full
 * union would add error variants no consumer reads.
 */
export type TranscriptionError = AnyTaggedError;

export type { TranscriptionSuccess } from '$lib/operations/transcription-history';

const TranscriptionOperationError = defineErrors({
	/** The hosted Epicenter gateway answered 402 (`InsufficientCredits`, ADR-0100):
	 *  the wallet could not cover this transcription. Surfaced as a credit-aware
	 *  message instead of the raw provider envelope, so the user knows the one thing
	 *  that fixes it. */
	InsufficientCredits: () => ({
		message:
			"You're out of Epicenter AI credits. Add credits from the dashboard to keep transcribing, or switch to your own provider in settings.",
	}),
	LocalTranscriptionUnavailableOnWeb: () => ({
		message:
			'Local transcription is only available in the desktop app. Choose a cloud or self-hosted provider on web.',
	}),
	LocalModelNotSelected: () => ({
		message: 'Please select a local model in settings.',
	}),
	RecordingAudioUnavailable: ({
		recordingId,
		cause,
	}: {
		recordingId: RecordingId;
		cause?: unknown;
	}) => ({
		message: 'The audio for this recording is unavailable.',
		recordingId,
		cause,
	}),
});

/**
 * How an upload (non-on-device) provider is reached. A `wire` provider resolves its own
 * transport and a model and hands them to the shared `transcribe()`; a `bespoke`
 * provider keeps its own SDK client (a different wire). The `kind` discriminant
 * carries the routing, so there is no wire-vs-bespoke id subset to derive and no
 * `in`-guard: one exhaustive switch on `.kind`.
 *
 * The transport is a `resolve` thunk, not static connection data, so each wire entry
 * owns how it becomes a transport (ADR-0060): a `key`/`endpoint` entry resolves a
 * `{ baseUrl, apiKey }` over `customFetch`, while the `session` Epicenter entry closes
 * over the signed-in session `fetch` (never connection data). The switch
 * therefore never branches on what kind of transport it got.
 *
 * A bespoke entry closes over its own key and model (from the literal `PROVIDERS.X`
 * pointers, the SSOT) rather than letting the caller read `PROVIDERS[id]`, because
 * switching on `.kind` does not narrow the id back to a KeyProvider. The wire
 * entries read the same pointers; the one fact `PROVIDERS` does not hold is the
 * canonical wire base URL (it used to be each SDK's default), so that literal lives
 * here.
 */
type UploadDispatch =
	| {
			kind: 'wire';
			resolve: () => ResolvedConnection;
			model: () => string;
	  }
	| {
			kind: 'bespoke';
			transcribe: (
				audio: Blob,
				options: { prompt: string; spokenLanguage: SupportedLanguage },
			) => Promise<Result<string, TranscriptionError>>;
	  };

/**
 * Read a provider API key through the credential facade (ADR-0074): the key when
 * set, undefined when missing. A provider key is a secret, so it routes through
 * `secrets`, never raw `deviceConfig`, which is what makes the user-global vault
 * cover transcription once auth lands. Device-local plaintext today.
 */
function secretApiKey(key: SecretKey): string | undefined {
	const read = secrets.get(key);
	return read.status === 'available' ? read.value : undefined;
}

/**
 * Every upload transcription provider, keyed by id. `satisfies Record<UploadProviderId,
 * UploadDispatch>` makes the table total over the non-on-device providers: a new cloud or
 * self-hosted provider is a compile error until it has an entry, and an on-device
 * provider cannot appear (it goes through the FFI path, branched in `transcribeAudio`).
 *
 * Wire entries (OpenAI, Groq, Speaches): the endpoint override beats the canonical
 * default; Speaches stores a bare host, so its `/v1` is appended; a keyless local
 * box sends no key. Bespoke entries (ElevenLabs, Deepgram, Mistral) keep their own
 * clients because they do not speak the wire (Deepgram's raw body + `Authorization:
 * Token`, ElevenLabs' `xi-api-key`, Mistral's `context_bias`); ADR-0060 blesses it.
 */
const uploadDispatch = (app: WhisperingApp) =>
	({
		// Epicenter (`session`) STT: the transport is the signed-in session fetch against
		// the deployment you are bonded to (`auth.deployment.baseURL`, so a self-hosted instance's own
		// gateway is used when connected to one), never a stored key. Both deployables mount
		// this gateway on their house key; a hosted deployment meters it (ADR-0100), a
		// self-host deployment does not. The model is fixed by the gateway.
		epicenter: {
			kind: 'wire',
			resolve: () => {
				const authenticated = app.beginAuthenticatedRequest?.();
				return {
					fetch: authenticated?.fetch ?? auth.fetch,
					baseURL: API_ROUTES.ai.baseUrl(
						authenticated?.baseURL ?? auth.deployment.baseURL,
					),
				};
			},
			model: () => PROVIDERS.epicenter.model,
		},
		OpenAI: {
			kind: 'wire',
			resolve: () =>
				resolveConnection(
					{
						baseUrl:
							deviceConfig.get(PROVIDERS.OpenAI.endpointConfigKey) ||
							'https://api.openai.com/v1',
						apiKey: secretApiKey(PROVIDERS.OpenAI.apiKeyConfigKey),
					},
					customFetch,
				),
			model: () => app.settings.get(PROVIDERS.OpenAI.modelSettingKey),
		},
		Groq: {
			kind: 'wire',
			resolve: () =>
				resolveConnection(
					{
						baseUrl:
							deviceConfig.get(PROVIDERS.Groq.endpointConfigKey) ||
							'https://api.groq.com/openai/v1',
						apiKey: secretApiKey(PROVIDERS.Groq.apiKeyConfigKey),
					},
					customFetch,
				),
			model: () => app.settings.get(PROVIDERS.Groq.modelSettingKey),
		},
		speaches: {
			kind: 'wire',
			resolve: () =>
				resolveConnection(
					{
						baseUrl: `${deviceConfig.get(PROVIDERS.speaches.endpointConfigKey)}/v1`,
					},
					customFetch,
				),
			model: () => deviceConfig.get(PROVIDERS.speaches.modelIdConfigKey),
		},
		ElevenLabs: {
			kind: 'bespoke',
			transcribe: (audio, { prompt, spokenLanguage }) =>
				ElevenLabsTranscriptionServiceLive.transcribe(audio, {
					prompt,
					spokenLanguage,
					apiKey: secretApiKey(PROVIDERS.ElevenLabs.apiKeyConfigKey) ?? '',
					modelName: app.settings.get(PROVIDERS.ElevenLabs.modelSettingKey),
				}),
		},
		Deepgram: {
			kind: 'bespoke',
			transcribe: (audio, { prompt, spokenLanguage }) =>
				DeepgramTranscriptionServiceLive.transcribe(audio, {
					prompt,
					spokenLanguage,
					apiKey: secretApiKey(PROVIDERS.Deepgram.apiKeyConfigKey) ?? '',
					modelName: app.settings.get(PROVIDERS.Deepgram.modelSettingKey),
				}),
		},
		Mistral: {
			kind: 'bespoke',
			transcribe: (audio, { prompt, spokenLanguage }) =>
				MistralTranscriptionServiceLive.transcribe(audio, {
					prompt,
					spokenLanguage,
					apiKey: secretApiKey(PROVIDERS.Mistral.apiKeyConfigKey) ?? '',
					modelName: app.settings.get(PROVIDERS.Mistral.modelSettingKey),
				}),
		},
	}) satisfies Record<UploadProviderId, UploadDispatch>;

/**
 * Materialize the bytes for an upload transcription. On Tauri, Rust reads the
 * recording's blob through the private host boundary and compresses it with
 * libopus. On the web, the original record blob is uploaded as-is.
 */
async function loadForUpload(
	app: WhisperingApp,
	recordingId: RecordingId,
): Promise<Result<Blob, TranscriptionError>> {
	if (tauri) {
		const { data: oggBytes, error } =
			await tauri.transcription.encodeRecordingForUpload(recordingId);
		if (error === null) return Ok(new Blob([oggBytes], { type: 'audio/ogg' }));
		report.info({
			title: 'Audio compression skipped',
			description: `${error}. Uploading uncompressed audio instead.`,
		});
		void logAnalyticsEvent(app, {
			type: 'compression_failed',
			provider: app.settings.get('transcription.service'),
			error_message: error,
		});
	}

	const read = await tryAsync({
		try: () => app.recordings.readAudio(recordingId),
		catch: (cause) =>
			TranscriptionOperationError.RecordingAudioUnavailable({
				recordingId,
				cause,
			}),
	});
	if (read.error !== null) return Err(read.error);
	if (read.data === null) {
		return TranscriptionOperationError.RecordingAudioUnavailable({
			recordingId,
		});
	}
	return Ok(read.data);
}

/**
 * Transcribe a saved recording by id. This is the single canonical entry
 * point for transcription:
 *
 * The recording record owns the bytes at its own address, so every caller
 * passes only that recording id. Upload providers read through the recordings
 * domain; the desktop host resolves the same address for on-device work.
 *
 * Local transcription always goes through `transcribe_recording(id)`.
 * Upload (non-on-device) transcription uploads compressed bytes derived from the
 * saved file when possible, falling back to the raw blob.
 */
export async function transcribeAudio(
	app: WhisperingApp,
	recordingId: RecordingId,
): Promise<Result<string, TranscriptionError>> {
	const selectedService = app.settings.get('transcription.service');

	const startTime = Date.now();
	void logAnalyticsEvent(app, {
		type: 'transcription_requested',
		provider: selectedService,
	});

	// The one place on-device-ness is decided. The type guard narrows `selectedService`
	// to `OnDeviceProviderId` in one arm and `UploadProviderId` in the other, so each
	// helper receives an already-narrowed id and neither re-checks.
	const transcriptionResult = isOnDeviceProviderId(selectedService)
		? await transcribeOnDevice(app, recordingId, selectedService)
		: await transcribeViaUpload(app, recordingId, selectedService);

	const duration = Date.now() - startTime;
	if (transcriptionResult.error) {
		void logAnalyticsEvent(app, {
			type: 'transcription_failed',
			provider: selectedService,
			error_name: transcriptionResult.error.name,
			error_message: transcriptionResult.error.message,
		});
	} else {
		void logAnalyticsEvent(app, {
			type: 'transcription_completed',
			provider: selectedService,
			duration,
		});
	}

	return transcriptionResult;
}

/**
 * Transcribe a saved recording by id and attempt to persist the outcome to the
 * recordings table. Successful text remains successful when history cannot be
 * confirmed: callers receive that secondary Result and choose how to warn.
 * Every path that transcribes (the record pipeline, manual retry, bulk) goes
 * through here, so they share one history-write policy.
 */
export async function transcribeAndPersist(
	app: WhisperingApp,
	recordingId: RecordingId,
): Promise<Result<TranscriptionSuccess, TranscriptionError>> {
	return recordTranscriptionOutcome(
		app,
		recordingId,
		await transcribeAudio(app, recordingId),
	);
}

/**
 * Warm the selected local model the instant a capture begins, so the cold
 * load (~1 s) overlaps the user's speech instead of being paid after they
 * stop. Called fire-and-forget from the manual and VAD start paths.
 *
 * No-op unless we are on desktop with an on-device provider selected and a model
 * chosen: cloud/self-hosted have no on-device model to load, and web has no Rust.
 * It resolves the model exactly the way `transcribeOnDevice` does, so it warms
 * the same model transcription will use. Failures are swallowed on purpose:
 * the worst case is transcription loads the model itself, as it does today.
 * `language`/`initialPrompt` are inference params, irrelevant to loading, so
 * they are sent null.
 */
export function prewarmOnDeviceModel(app: WhisperingApp): void {
	if (!tauri) return;

	const selectedService = app.settings.get('transcription.service');
	if (!isOnDeviceProviderId(selectedService)) return;

	const modelId = deviceConfig.get(PROVIDERS[selectedService].modelConfigKey);
	if (!modelId) return;

	void tauri.transcription.prewarmModel({
		modelId,
		language: null,
		initialPrompt: null,
	});
}

/**
 * Fold the user's Dictionary into a transcription prompt. Both the cloud `prompt`
 * and the local `initialPrompt` are freeform context the recognizer biases
 * toward, so appending the terms as a glossary nudges it to spell proper nouns
 * and jargon the way the user wrote them. Composition stays here in the app, not
 * in `@epicenter/client`: the wire just carries one prompt string. An empty
 * Dictionary returns the prompt unchanged. See ADR-0099.
 */
function withDictionaryTerms(prompt: string, dictionary: string[]): string {
	if (dictionary.length === 0) return prompt;
	const glossary = dictionary.join(', ');
	const trimmed = prompt.trim();
	return trimmed ? `${trimmed} ${glossary}` : glossary;
}

async function transcribeOnDevice(
	app: WhisperingApp,
	recordingId: RecordingId,
	selectedService: OnDeviceProviderId,
): Promise<Result<string, TranscriptionError>> {
	if (!tauri) {
		return TranscriptionOperationError.LocalTranscriptionUnavailableOnWeb();
	}

	// Rust owns model resolution and validation: it resolves this catalog id to a
	// shared-HF-cache path and reports an unknown or not-downloaded model with a
	// user-facing message. The FE keeps the one check Rust cannot make as well:
	// "nothing selected yet" (instant, no IPC).
	const modelId = deviceConfig.get(PROVIDERS[selectedService].modelConfigKey);
	if (!modelId) {
		return TranscriptionOperationError.LocalModelNotSelected();
	}

	// Read-at-use: the per-call spec is built right here, where it is consumed,
	// so there is no ambient config to go stale. `auto` language and an empty
	// prompt map to the wire's "unset" (an omitted optional field). The Dictionary
	// terms fold into the prompt so local recognition spells them the user's way.
	const language = app.settings.get('transcription.language');
	const prompt = withDictionaryTerms(
		app.settings.get('transcription.prompt'),
		app.settings.get('dictionary'),
	);
	return tauri.transcription.transcribeRecording(recordingId, {
		modelId,
		language: language === 'auto' ? undefined : language,
		initialPrompt: prompt || undefined,
	});
}

async function transcribeViaUpload(
	app: WhisperingApp,
	recordingId: RecordingId,
	selectedService: UploadProviderId,
): Promise<Result<string, TranscriptionError>> {
	const entry = uploadDispatch(app)[selectedService];
	// Bind authenticated wires before reading local audio. In browsers the
	// returned transport is fenced to this operation's principal generation, so
	// an account switch during the read terminates the old operation instead of
	// sending its audio with the new account's credentials.
	const connection = entry.kind === 'wire' ? entry.resolve() : undefined;
	const { data: audio, error: loadError } = await loadForUpload(
		app,
		recordingId,
	);
	if (loadError) return Err(loadError);

	// `auto` language and an empty prompt map to the wire's "unset" (omitted from
	// the form). No per-provider key-format pre-check: no key just means no header,
	// and the server answers 401, surfaced as a RequestFailed carrying that detail.
	// The Dictionary terms fold into the prompt so cloud recognition spells them
	// the user's way.
	const spokenLanguage = app.settings.get('transcription.language');
	const prompt = withDictionaryTerms(
		app.settings.get('transcription.prompt'),
		app.settings.get('dictionary'),
	);
	switch (entry.kind) {
		case 'wire': {
			if (connection === undefined) {
				throw new Error('Wire transcription has no resolved transport');
			}
			const result = await transcribe(audio, connection, {
				model: entry.model(),
				language: spokenLanguage === 'auto' ? undefined : spokenLanguage,
				prompt: prompt || undefined,
			});
			// Only the `session` wire can meter credits, and only when bonded to a hosted
			// deployment, so a 402 there is `InsufficientCredits` (ADR-0100). Remap it to
			// a credit-aware message; every other wire's 402 (none expected) stays a raw
			// RequestFailed. A self-host deployment never meters, so it never 402s here.
			if (
				selectedService === 'epicenter' &&
				result.error?.name === 'RequestFailed' &&
				result.error.status === 402
			) {
				return TranscriptionOperationError.InsufficientCredits();
			}
			return result;
		}
		case 'bespoke':
			return entry.transcribe(audio, { prompt, spokenLanguage });
	}
}
