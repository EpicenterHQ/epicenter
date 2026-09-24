import { blobInputContentType, selectBlobFormat } from '@epicenter/blobs';
import { InstantString } from '@epicenter/app/field';
import { APIError } from 'openai';
import {
	type AnyTaggedError,
	defineErrors,
	extractErrorMessage,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync, trySync } from 'wellcrafted/result';
import { isSupportedLanguage } from '../constants/languages.js';
import type { RecordingId } from '../data.js';
import type { RecordingStore, WhisperingApp } from '../whispering/app.js';
import { getInferenceTarget } from '../whispering/inference.js';
import { local } from '../whispering/local.js';
import { DEVICE_DEFAULTS, PERSONAL_DEFAULTS } from './settings.js';
import {
	recordTranscriptionOutcome,
	type TranscriptionSuccess,
} from './transcription-history.js';

export type TranscriptionError = AnyTaggedError;
export type { TranscriptionSuccess } from './transcription-history.js';
type CapturedTranscription = ((
	recordingId: RecordingId,
) => Promise<Result<string, TranscriptionError>>) & {
	selection?: ReturnType<typeof getInferenceTarget>;
};

const TranscriptionOperationError = defineErrors({
	SelectionRequired: () => ({
		message:
			'Choose a transcription connection and model in Privacy & Processing settings.',
	}),
	Closed: () => ({
		message: 'Recording data is unavailable. Reopen Whispering to transcribe.',
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
	return app.catalog.resolve(getInferenceTarget(local.kv, 'transcription'));
}

/** Capture the inference target before recording or import. No selection means audio only. */
export function captureTranscription(
	app: WhisperingApp,
	store: RecordingStore,
): CapturedTranscription | null {
	let usesAccount = false;
	let capturedSelection: ReturnType<typeof getInferenceTarget> = null;
	const prepared = trySync({
		try: () => {
			app.signal.throwIfAborted();
			const language =
				local.kv.get('transcriptionLanguage') ??
				DEVICE_DEFAULTS.transcriptionLanguage;
			const spokenLanguage = isSupportedLanguage(language) ? language : 'auto';
			const promptFrom = (personal: Awaited<WhisperingApp['personalReady']>) =>
				[
					(
						personal?.kv.get('transcriptionPrompt') ??
						PERSONAL_DEFAULTS.transcriptionPrompt
					).trim(),
					(personal?.kv.get('dictionary') ?? []).join(', '),
				]
					.filter(Boolean)
					.join(' ');
			// Snapshot ready inputs now; a late store is the captured account's acquisition.
			const promptReady = app.personalReady.then(promptFrom);
			void promptReady.catch(() => {});
			const selection = getInferenceTarget(local.kv, 'transcription');
			capturedSelection = selection;
			if (!selection) return Ok(null);
			const capturedTarget = app.catalog.loading
				? undefined
				: app.catalog.resolve(selection);
			const transcribe = async (audio: Blob) => {
				const prompt = await promptReady;
				await app.catalog.ready;
				app.signal.throwIfAborted();
				const target =
					capturedTarget === undefined
						? app.catalog.resolve(selection)
						: capturedTarget;
				if (!target) return TranscriptionOperationError.SelectionRequired();
				const { model, source } = target;
				usesAccount = source === 'account';
				if (target.source === 'runtime') {
					const result = await target.transcriber.transcribe(
						{
							audio,
							model,
							language: spokenLanguage === 'auto' ? undefined : spokenLanguage,
							prompt: prompt || undefined,
						},
						{ signal: app.signal },
					);
					return result.error ? result : Ok(result.data.text);
				}
				const response = await target.client.audio.transcriptions.create(
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
		return Object.assign(async () => Err(error), { selection: capturedSelection });
	}
	const selected = target.data;
	if (selected === null) return null;
	return Object.assign(async (
		recordingId: RecordingId,
	): Promise<Result<string, TranscriptionError>> => {
		const result = await tryAsync({
			try: async () => {
				if (app.signal.aborted || !store.tables.recordings.get(recordingId))
					return TranscriptionOperationError.Closed();
				const audio = await store.blobs.get(
					store.tables.recordings.get(recordingId)!.audioBlobId,
				);
				if (app.signal.aborted || !store.tables.recordings.get(recordingId))
					return TranscriptionOperationError.Closed();
				if (audio.error) return Err(audio.error);
				const transcription = await selected(audio.data);
				if (app.signal.aborted || !store.tables.recordings.get(recordingId))
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
	}, { selection: capturedSelection });
}

/** A deliberate transcription captures its selection when invoked. */
export async function transcribeAudio(
	recordingId: RecordingId,
	owner: WhisperingApp,
	store: RecordingStore,
) {
	const transcribe = captureTranscription(owner, store);
	return transcribe
		? transcribe(recordingId)
		: TranscriptionOperationError.SelectionRequired();
}

/** Every saved transcription attempts history only while its captured App is alive. */
export async function transcribeAndPersist(
	app: WhisperingApp,
	store: RecordingStore,
	recordingId: RecordingId,
	transcribe = captureTranscription(app, store),
): Promise<Result<TranscriptionSuccess, TranscriptionError>> {
	const signal = app.signal;
	const attemptedAt = InstantString.now();
	if (transcribe === null)
		return TranscriptionOperationError.SelectionRequired();
	const reserved = trySync({
		try: () => app.pendingSaves.reserve('Transcript'),
		catch: (cause) => TranscriptionOperationError.TransportFailed({ cause }),
	});
	if (reserved.error) return reserved;
	const result = await transcribe(recordingId);
	if (signal.aborted) {
		reserved.data.discard();
		return TranscriptionOperationError.Closed();
	}
	return recordTranscriptionOutcome(
		app,
		store,
		recordingId,
		result,
		reserved.data,
		attemptedAt,
		transcribe.selection ?? null,
	);
}
