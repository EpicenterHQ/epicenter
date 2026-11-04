/**
 * The one client: OpenAI-shaped requests posted through an endpoint's
 * `fetch`, OpenAI-shaped answers read back. Chat always streams (server-sent
 * events); transcription, embeddings and the model list answer once.
 *
 * Every ordinary failure is a `Result` error: an unreachable endpoint, a
 * refusal (any non-2xx answer, with the provider's message and code when it
 * sent them), an answer that does not read, and an error the provider sent
 * mid-stream. A chat stream ends after its first error.
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
	Failed: ({ message, code }: { message: string; code?: string }) => ({
		message,
		code,
	}),
	Malformed: ({ reason }: { reason: string }) => ({
		message: `The endpoint's answer did not read: ${reason}.`,
		reason,
	}),
	Cancelled: () => ({ message: 'The request was cancelled.' }),
});
export type AiError = InferErrors<typeof AiError>;

/** One tool call in a chat transcript. */
export type ToolCall = {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
};

export type ChatMessage =
	| { role: 'system' | 'developer'; content: string }
	| { role: 'user'; content: string }
	| { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
	| { role: 'tool'; tool_call_id: string; content: string };

export type ChatTool = {
	type: 'function';
	function: {
		name: string;
		description?: string;
		parameters: Record<string, unknown>;
	};
};

export type ChatRequest = {
	model: string;
	messages: ChatMessage[];
	tools?: ChatTool[];
	temperature?: number;
	max_completion_tokens?: number;
};

/** One fragment of a tool call as a stream sends it; some providers omit `index`. */
export type ToolCallDelta = {
	index?: number;
	id?: string;
	type?: 'function';
	function?: { name?: string; arguments?: string };
};

/** One server-sent chat chunk. A usage-only chunk has no choices. */
export type ChatChunk = {
	id?: string;
	model?: string;
	choices: {
		index?: number;
		delta?: {
			role?: string;
			content?: string | null;
			refusal?: string | null;
			tool_calls?: ToolCallDelta[];
		};
		finish_reason?: string | null;
	}[];
	usage?: Record<string, unknown> | null;
};

/** Audio to transcribe, uploaded as `file` to every endpoint, as any OpenAI client sends it. */
export type TranscriptionRequest = {
	model: string;
	file: Blob;
	language?: string;
	prompt?: string;
};

export type Transcription = { text: string };

export type EmbeddingsRequest = { model: string; input: string | string[] };

export type Embeddings = { data: { index: number; embedding: number[] }[] };

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
		/**
		 * Stream a chat completion. Each item is a chunk or, last, the error
		 * that ended the stream. Aborting `signal`, or leaving the loop, cancels
		 * the response.
		 */
		async *chat(
			request: ChatRequest,
			{ signal }: Options = {},
		): AsyncGenerator<Result<ChatChunk, AiError>> {
			const sent = await send(
				'chat/completions',
				{
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						accept: 'text/event-stream',
					},
					body: JSON.stringify({
						...request,
						stream: true,
						stream_options: { include_usage: true },
					}),
				},
				signal,
			);
			if (sent.error !== null) {
				yield sent;
				return;
			}
			const body = sent.data.body;
			if (!body) {
				yield AiError.Malformed({ reason: 'no stream' });
				return;
			}
			const reader = body.getReader();
			const cancel = () => void reader.cancel().catch(() => {});
			signal?.addEventListener('abort', cancel, { once: true });
			const decoder = new TextDecoder();
			let buffer = '';
			let data: string[] = [];
			try {
				for (;;) {
					if (signal?.aborted) {
						yield AiError.Cancelled();
						return;
					}
					const { done, value } = await reader.read().catch((cause) => {
						if (signal?.aborted) return { done: true, value: undefined };
						throw cause;
					});
					if (signal?.aborted) {
						yield AiError.Cancelled();
						return;
					}
					buffer += done
						? decoder.decode()
						: decoder.decode(value, { stream: true });
					const events: string[] = [];
					for (;;) {
						const end = /\r\n|\r|\n/.exec(buffer);
						if (!end) break;
						// A lone CR at the end of a chunk may be half of a CRLF.
						if (end[0] === '\r' && end.index === buffer.length - 1 && !done)
							break;
						const line = buffer.slice(0, end.index);
						buffer = buffer.slice(end.index + end[0].length);
						if (line === '') {
							if (data.length) events.push(data.join('\n'));
							data = [];
						} else if (line === 'data' || line.startsWith('data:')) {
							const value = line.slice(5);
							data.push(value.startsWith(' ') ? value.slice(1) : value);
						}
					}
					if (done && data.length) events.push(data.join('\n'));
					for (const event of events) {
						if (event === '[DONE]') return;
						let parsed: unknown;
						try {
							parsed = JSON.parse(event);
						} catch {
							yield AiError.Malformed({
								reason: 'malformed server-sent event JSON',
							});
							return;
						}
						if (!isRecord(parsed)) {
							yield AiError.Malformed({ reason: 'a chunk is not an object' });
							return;
						}
						if (parsed.error !== undefined) {
							const error = parsed.error;
							yield AiError.Failed({
								message:
									isRecord(error) && typeof error.message === 'string'
										? error.message
										: typeof error === 'string'
											? error
											: 'The provider reported an error.',
								code:
									isRecord(error) && typeof error.code === 'string'
										? error.code
										: undefined,
							});
							return;
						}
						if (
							parsed.choices !== undefined &&
							!Array.isArray(parsed.choices)
						) {
							yield AiError.Malformed({ reason: 'choices is not a list' });
							return;
						}
						yield Ok({ ...parsed, choices: parsed.choices ?? [] } as ChatChunk);
					}
					if (done) return;
				}
			} catch (cause) {
				yield signal?.aborted
					? AiError.Cancelled()
					: AiError.Unreachable({ cause });
			} finally {
				signal?.removeEventListener('abort', cancel);
				cancel();
			}
		},

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

		/** Embed one input or several. */
		async embed(
			request: EmbeddingsRequest,
			{ signal }: Options = {},
		): Promise<Result<Embeddings, AiError>> {
			const sent = await send(
				'embeddings',
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(request),
				},
				signal,
			);
			if (sent.error !== null) return sent;
			const body = await readJson(sent.data, signal);
			if (body.error !== null) return body;
			const data = isRecord(body.data) ? body.data.data : undefined;
			if (
				!Array.isArray(data) ||
				data.some(
					(entry) =>
						!isRecord(entry) ||
						typeof entry.index !== 'number' ||
						!Array.isArray(entry.embedding),
				)
			)
				return AiError.Malformed({ reason: 'no embeddings' });
			return Ok({ data: data as Embeddings['data'] });
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
export type Client = ReturnType<typeof createClient>;
