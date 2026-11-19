/**
 * The one client: OpenAI-shaped requests posted through an endpoint's
 * `fetch`, OpenAI-shaped answers read back: a transcription and the model
 * list.
 *
 * Every ordinary failure is a `Result` error: an unreachable endpoint, a
 * refusal (any non-2xx answer, with the provider's message and code when it
 * sent them), and an answer that does not read.
 */

import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { EndpointFetch } from './endpoint.js';

export const AiError = defineErrors({
	NoEndpoint: ({ endpoint }: { endpoint: string }) => ({
		message: `No endpoint named "${endpoint}" is available.`,
		endpoint,
	}),
	Unreachable: ({ cause }: { cause: unknown }) => ({
		message: `Could not reach the endpoint: ${extractErrorMessage(cause)}`,
		cause,
	}),
	Refused: ({
		status,
		message,
		code,
	}: {
		status: number;
		message?: string;
		code?: string;
	}) => ({
		message: message ?? `The endpoint answered ${status}.`,
		status,
		code,
	}),
	Malformed: ({ reason }: { reason: string }) => ({
		message: `The endpoint's answer did not read: ${reason}.`,
		reason,
	}),
	Cancelled: () => ({ message: 'The request was cancelled.' }),
});
export type AiError = InferErrors<typeof AiError>;

/** Audio to transcribe, uploaded as `file` to every endpoint, as any OpenAI client sends it. */
export type TranscriptionRequest = {
	model: string;
	file: Blob;
	language?: string;
	prompt?: string;
};

export type Transcription = { text: string };

type Options = { signal?: AbortSignal };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** A non-2xx answer as a refusal, keeping an OpenAI error body's message and code. */
async function refusal(response: Response): Promise<AiError> {
	let message: string | undefined;
	let code: string | undefined;
	const text = await response.text().catch(() => '');
	try {
		const body: unknown = JSON.parse(text);
		const error = isRecord(body) ? body.error : undefined;
		if (typeof error === 'string') message = error;
		else if (isRecord(error)) {
			if (typeof error.message === 'string') message = error.message;
			if (typeof error.code === 'string') code = error.code;
		} else if (isRecord(body) && typeof body.message === 'string')
			message = body.message;
	} catch {
		if (text.trim()) message = text.trim().slice(0, 500);
	}
	return AiError.Refused({ status: response.status, message, code }).error;
}

/** The requests one endpoint answers, sent through its `fetch`. */
export function createClient({ fetch }: { fetch: EndpointFetch }) {
	async function send(
		path: string,
		init: RequestInit,
		signal: AbortSignal | undefined,
	): Promise<Result<Response, AiError>> {
		const { data: response, error } = await tryAsync({
			try: () => fetch(path, { ...init, signal }),
			catch: (cause) =>
				signal?.aborted ? AiError.Cancelled() : AiError.Unreachable({ cause }),
		});
		if (error !== null) return Err(error);
		if (!response.ok) return Err(await refusal(response));
		return Ok(response);
	}

	async function readJson(
		response: Response,
		signal: AbortSignal | undefined,
	): Promise<Result<unknown, AiError>> {
		return tryAsync({
			try: () => response.json() as Promise<unknown>,
			catch: () =>
				signal?.aborted
					? AiError.Cancelled()
					: AiError.Malformed({ reason: 'not JSON' }),
		});
	}

	return {
		/** Transcribe audio, posted as `multipart/form-data`. */
		async transcribe(
			request: TranscriptionRequest,
			{ signal }: Options = {},
		): Promise<Result<Transcription, AiError>> {
			const form = new FormData();
			form.set('model', request.model);
			form.set(
				'file',
				request.file,
				request.file instanceof File ? request.file.name : 'audio',
			);
			if (request.language) form.set('language', request.language);
			if (request.prompt) form.set('prompt', request.prompt);
			const sent = await send(
				'audio/transcriptions',
				{ method: 'POST', body: form },
				signal,
			);
			if (sent.error !== null) return sent;
			const body = await readJson(sent.data, signal);
			if (body.error !== null) return body;
			if (!isRecord(body.data) || typeof body.data.text !== 'string')
				return AiError.Malformed({ reason: 'no transcribed text' });
			return Ok({ text: body.data.text });
		},

		/** The ids the endpoint lists at `models`. */
		async listModels({
			signal,
		}: Options = {}): Promise<Result<string[], AiError>> {
			const sent = await send('models', { method: 'GET' }, signal);
			if (sent.error !== null) return sent;
			const body = await readJson(sent.data, signal);
			if (body.error !== null) return body;
			const data = isRecord(body.data) ? body.data.data : undefined;
			if (
				!Array.isArray(data) ||
				data.some((entry) => !isRecord(entry) || typeof entry.id !== 'string')
			)
				return AiError.Malformed({ reason: 'not a { data: [{ id }] } list' });
			return Ok(data.map((entry: { id: string }) => entry.id));
		},
	};
}
