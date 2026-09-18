import { matchInferenceTarget } from '@epicenter/app-shell/inference-selections';
import { blobInputContentType, selectBlobFormat } from '@epicenter/blobs';
import { APIError } from 'openai';
import {
	type AnyTaggedError,
	defineErrors,
	extractErrorMessage,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync, trySync } from 'wellcrafted/result';
import { getApp, getSelections } from '../application.js';
import { isSupportedLanguage } from '../constants/languages.js';
import type { RecordingId } from '../data.js';
import { DeepgramTranscriptionServiceLive } from '../services/transcription/cloud/deepgram.js';
import { ElevenLabsTranscriptionServiceLive } from '../services/transcription/cloud/elevenlabs.js';
import { MistralTranscriptionServiceLive } from '../services/transcription/cloud/mistral.js';
import { PROVIDERS } from '../services/transcription/providers.js';
import { secrets } from '../state/secrets.svelte.js';
import type { WhisperingApp } from '../whispering/app.js';
import { settings } from './settings.js';
import {
	recordTranscriptionOutcome,
	type TranscriptionSuccess,
} from './transcription-history.js';

export type TranscriptionError = AnyTaggedError;
export type { TranscriptionSuccess } from './transcription-history.js';

const TranscriptionOperationError = defineErrors({
	SelectionRequired: () => ({
		message:
			'Choose a transcription connection and model in Privacy & Processing settings.',
	}),
	Closed: () => ({
		message: 'This library has closed. Reopen it to transcribe.',
	}),
	InsufficientCredits: () => ({
		message:
			"You're out of Epicenter AI credits. Add credits on the account website, then return and retry your recording. You can also choose another connection in settings.",
	}),
	TransportFailed: ({ cause }: { cause: unknown }) => ({
		message: `Could not transcribe the recording: ${extractErrorMessage(cause)}`,
		cause,
	}),
	RequestFailed: ({ status, detail }: { status: number; detail: string }) => ({
		message: `Transcription failed (${status}): ${detail}`,
		status,
	}),
	Malformed: () => ({
		message: 'The transcription response did not contain text.',
	}),
});

/** Capture the exact saved SDK target. Discovery never chooses its destination. */
export function resolveTranscriptionState() {
	const app = getApp();
	const model = settings.get('transcriptionModel');
	const selected = getSelections().get('transcription');
	const client =
		selected?.model === model
			? matchInferenceTarget(
					{
						runtime: app.device.connections.runtime,
						connections: app.device.connections.custom,
						account: app.account?.connection ?? null,
					},
					selected,
				)
			: null;
	const account = client !== null && client === app.account?.connection?.client;
	return {
		client,
		model,
		account,
		canRun: client !== null && model.trim().length > 0,
	};
}

/** Capture the inference target before recording or import. No selection means audio only. */
export function captureTranscription(owner: WhisperingApp) {
	let usesAccount = false;
	const prepared = trySync({
		try: () => {
			const app = getApp();
			if (app.signal !== owner.signal)
				return TranscriptionOperationError.Closed();
			app.signal.throwIfAborted();
			const service = settings.get('transcriptionService');
			const language = settings.get('transcriptionLanguage');
			const spokenLanguage = isSupportedLanguage(language) ? language : 'auto';
			const prompt = [
				settings.get('transcriptionPrompt').trim(),
				(settings.get('dictionary') ?? []).join(', '),
			]
				.filter(Boolean)
				.join(' ');
			let transcribe: (
				audio: Blob,
			) => Promise<Result<string, TranscriptionError>>;
			if (
				service === 'Deepgram' ||
				service === 'ElevenLabs' ||
				service === 'Mistral'
			) {
				const provider = PROVIDERS[service];
				const key = secrets.get(provider.apiKeyConfigKey);
				const options = {
					prompt,
					spokenLanguage,
					apiKey: key.status === 'available' ? key.value : '',
					modelName: settings.get(provider.modelSettingKey),
				};
				const implementation = {
					Deepgram: DeepgramTranscriptionServiceLive,
					ElevenLabs: ElevenLabsTranscriptionServiceLive,
					Mistral: MistralTranscriptionServiceLive,
				}[service];
				transcribe = (audio) => implementation.transcribe(audio, options);
			} else {
				// Previous provider fields are an explicit import source, never a fallback.
				if (service !== 'connection')
					return TranscriptionOperationError.SelectionRequired();
				if (!getSelections().get('transcription')) return Ok(null);
				const { client, model, account, canRun } = resolveTranscriptionState();
				if (!client || !canRun)
					return TranscriptionOperationError.SelectionRequired();
				usesAccount = account;
				transcribe = async (audio) => {
					const response = await client.audio.transcriptions.create(
						{
							// Bun 1.3.14 retains a single source File's cached name.
							file: new File(
								[audio, ''],
								`audio.${selectBlobFormat(audio).extension}`,
								{
									type: blobInputContentType(audio),
								},
							),
							model,
							language: spokenLanguage === 'auto' ? undefined : spokenLanguage,
							prompt: prompt || undefined,
						},
						{ signal: app.signal },
					);
					return typeof response.text === 'string'
						? Ok(response.text.trim())
						: TranscriptionOperationError.Malformed();
				};
			}
			return Ok(transcribe);
		},
		catch: (cause) => TranscriptionOperationError.TransportFailed({ cause }),
	});
	const target = prepared.error ? Err(prepared.error) : prepared.data;
	if (target.error) {
		const error = target.error;
		return async () => Err(error);
	}
	const selected = target.data;
	if (selected === null) return null;
	return async (
		recordingId: RecordingId,
	): Promise<Result<string, TranscriptionError>> => {
		const result = await tryAsync({
			try: async () => {
				if (owner.signal.aborted || !owner.recordings.get(recordingId))
					return TranscriptionOperationError.Closed();
				const audio = await owner.recordings.readAudio(recordingId);
				if (owner.signal.aborted || !owner.recordings.get(recordingId))
					return TranscriptionOperationError.Closed();
				if (audio.error) return Err(audio.error);
				const transcription = await selected(audio.data);
				if (owner.signal.aborted || !owner.recordings.get(recordingId))
					return TranscriptionOperationError.Closed();
				return transcription;
			},
			catch: (cause) => {
				if (cause instanceof APIError && cause.status !== undefined) {
					if (usesAccount && cause.status === 402)
						return TranscriptionOperationError.InsufficientCredits();
					return TranscriptionOperationError.RequestFailed({
						status: cause.status,
						detail: cause.message,
					});
				}
				if (cause instanceof SyntaxError)
					return TranscriptionOperationError.Malformed();
				return TranscriptionOperationError.TransportFailed({ cause });
			},
		});
		return result.error ? Err(result.error) : result.data;
	};
}

/** A deliberate transcription captures its selection when invoked. */
export async function transcribeAudio(
	recordingId: RecordingId,
	owner: WhisperingApp,
) {
	const transcribe = captureTranscription(owner);
	return transcribe
		? transcribe(recordingId)
		: TranscriptionOperationError.SelectionRequired();
}

/** Every saved transcription attempts history only while its captured App is alive. */
export async function transcribeAndPersist(
	app: WhisperingApp,
	recordingId: RecordingId,
	transcribe = captureTranscription(app),
): Promise<Result<TranscriptionSuccess, TranscriptionError>> {
	const signal = app.signal;
	if (transcribe === null)
		return TranscriptionOperationError.SelectionRequired();
	const result = await transcribe(recordingId);
	if (signal.aborted) return TranscriptionOperationError.Closed();
	return recordTranscriptionOutcome(app, recordingId, result);
}
