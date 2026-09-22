import { blobInputContentType, selectBlobFormat } from '@epicenter/blobs';
import { APIError } from 'openai';
import {
	type AnyTaggedError,
	defineErrors,
	extractErrorMessage,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync, trySync } from 'wellcrafted/result';
import { isSupportedLanguage } from '../constants/languages.js';
import type { RecordingId } from '../data.js';
import type { WhisperingApp } from '../whispering/app.js';
import { getInferenceTarget } from '../whispering/inference.js';
import { readRecordingAudio } from '../whispering/recordings.js';
import { DEVICE_DEFAULTS, PERSONAL_DEFAULTS } from './settings.js';
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
export function resolveTranscriptionTarget(app: WhisperingApp) {
	return app.catalog.resolve(getInferenceTarget(app.local.kv, 'transcription'));
}

/** Capture the inference target before recording or import. No selection means audio only. */
export function captureTranscription(app: WhisperingApp) {
	let usesAccount = false;
	const prepared = trySync({
		try: () => {
			app.signal.throwIfAborted();
			const language =
				app.local.kv.get('transcriptionLanguage') ??
				DEVICE_DEFAULTS.transcriptionLanguage;
			const spokenLanguage = isSupportedLanguage(language) ? language : 'auto';
			const prompt = [
				(
					app.personal?.kv.get('transcriptionPrompt') ??
					PERSONAL_DEFAULTS.transcriptionPrompt
				).trim(),
				(app.personal?.kv.get('dictionary') ?? []).join(', '),
			]
				.filter(Boolean)
				.join(' ');
			const selection = getInferenceTarget(app.local.kv, 'transcription');
			if (!selection) return Ok(null);
			const target = app.catalog.resolve(selection);
			if (!target) return TranscriptionOperationError.SelectionRequired();
			const { client, model, source } = target;
			usesAccount = source === 'account';
			const transcribe = async (audio: Blob) => {
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
				if (
					app.signal.aborted ||
					!app.library.tables.recordings.get(recordingId)
				)
					return TranscriptionOperationError.Closed();
				const audio = await readRecordingAudio(app, recordingId);
				if (
					app.signal.aborted ||
					!app.library.tables.recordings.get(recordingId)
				)
					return TranscriptionOperationError.Closed();
				if (audio.error) return Err(audio.error);
				const transcription = await selected(audio.data);
				if (
					app.signal.aborted ||
					!app.library.tables.recordings.get(recordingId)
				)
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
