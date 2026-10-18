/** Application workflows map SDK failures to these Results for their callers. */
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';

export const TranscribeError = defineErrors({
	TransportFailed: ({ cause }: { cause: unknown }) => ({
		message: `Could not reach the transcription endpoint: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type TranscribeError = InferErrors<typeof TranscribeError>;

export const ListModelsError = defineErrors({
	Unreachable: ({ cause }: { cause: unknown }) => ({
		message: `Could not reach the endpoint to list models: ${extractErrorMessage(cause)}`,
		cause,
	}),
	RequestFailed: ({ status }: { status: number }) => ({
		message: `The endpoint returned ${status} for /models.`,
		status,
	}),
	Malformed: () => ({
		message: 'The /models response was not an OpenAI { data: [{ id }] } list.',
	}),
});
export type ListModelsError = InferErrors<typeof ListModelsError>;
