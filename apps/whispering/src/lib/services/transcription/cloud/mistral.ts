import { blobInputContentType, selectBlobFormat } from '@epicenter/blobs';
import { Mistral } from '@mistralai/mistralai';
import { MistralError as MistralSdkError } from '@mistralai/mistralai/models/errors';
import { ConnectionError as MistralConnectionError } from '@mistralai/mistralai/models/errors/httpclienterrors';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync, trySync } from 'wellcrafted/result';

const MAX_FILE_SIZE_MB = 25 as const;

export const MistralTranscriptionError = defineErrors({
	MissingApiKey: () => ({
		message: 'Mistral API key is required',
	}),
	FileTooLarge: ({ sizeMb, maxMb }: { sizeMb: number; maxMb: number }) => ({
		message: `File size ${sizeMb.toFixed(1)}MB exceeds ${maxMb}MB limit`,
		sizeMb,
		maxMb,
	}),
	FileCreationFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to create audio file for transcription: ${extractErrorMessage(cause)}`,
		cause,
	}),
	Unauthorized: ({ cause }: { cause: MistralSdkError }) => ({
		message: cause.message,
		cause,
	}),
	RateLimit: ({ cause }: { cause: MistralSdkError }) => ({
		message: cause.message,
		cause,
	}),
	PayloadTooLarge: ({ cause }: { cause: MistralSdkError }) => ({
		message: cause.message,
		cause,
	}),
	BadRequest: ({ cause }: { cause: MistralSdkError }) => ({
		message: cause.message,
		cause,
	}),
	ServiceUnavailable: ({
		cause,
		status,
	}: {
		cause: MistralSdkError;
		status: number;
	}) => ({
		message: cause.message,
		cause,
		status,
	}),
	Connection: ({ cause }: { cause: MistralConnectionError }) => ({
		message: cause.message,
		cause,
	}),
	InvalidResponse: () => ({
		message: 'Mistral API returned an invalid response format',
	}),
	Unexpected: ({ cause }: { cause: unknown }) => ({
		message: extractErrorMessage(cause),
		cause,
	}),
});
export type MistralTranscriptionError = InferErrors<
	typeof MistralTranscriptionError
>;

export const MistralTranscriptionServiceLive = {
	async transcribe(
		audioBlob: Blob,
		options: {
			prompt: string;
			spokenLanguage: string;
			apiKey: string;
			modelName: string;
		},
	): Promise<Result<string, MistralTranscriptionError>> {
		if (!options.apiKey) return MistralTranscriptionError.MissingApiKey();

		const sizeMb = audioBlob.size / (1024 * 1024);
		if (sizeMb > MAX_FILE_SIZE_MB) {
			return MistralTranscriptionError.FileTooLarge({
				sizeMb,
				maxMb: MAX_FILE_SIZE_MB,
			});
		}

		const { data: file, error: fileError } = trySync({
			try: () =>
				new File(
					[audioBlob],
					`recording.${selectBlobFormat(audioBlob).extension}`,
					{ type: blobInputContentType(audioBlob) },
				),
			catch: (cause) => MistralTranscriptionError.FileCreationFailed({ cause }),
		});

		if (fileError) return Err(fileError);

		const { data: transcription, error: apiError } = await tryAsync({
			try: () =>
				new Mistral({ apiKey: options.apiKey }).audio.transcriptions.complete({
					file,
					model: options.modelName,
					language:
						options.spokenLanguage !== 'auto'
							? options.spokenLanguage
							: undefined,
				}),
			catch: (error) => {
				if (error instanceof MistralConnectionError) {
					return MistralTranscriptionError.Connection({ cause: error });
				}
				if (!(error instanceof MistralSdkError)) {
					return MistralTranscriptionError.Unexpected({ cause: error });
				}
				switch (error.statusCode) {
					case 400:
						return MistralTranscriptionError.BadRequest({ cause: error });
					case 401:
						return MistralTranscriptionError.Unauthorized({ cause: error });
					case 413:
						return MistralTranscriptionError.PayloadTooLarge({ cause: error });
					case 429:
						return MistralTranscriptionError.RateLimit({ cause: error });
					default:
						if (error.statusCode >= 500) {
							return MistralTranscriptionError.ServiceUnavailable({
								cause: error,
								status: error.statusCode,
							});
						}
						return MistralTranscriptionError.Unexpected({ cause: error });
				}
			},
		});

		if (apiError) return Err(apiError);

		if (!transcription || typeof transcription.text !== 'string') {
			return MistralTranscriptionError.InvalidResponse();
		}

		return Ok(transcription.text.trim());
	},
};
