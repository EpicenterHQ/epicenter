/**
 * The two requests Whispering makes, as the OpenAI wire states them, and how
 * each answer reads: a transcription of a recording's audio, and a chat
 * completion that runs a recipe's instructions over a text.
 *
 * A request names a path below its connection's endpoint and nothing about
 * where it goes or with which key. `send` in `connection-routes.ts` sends it
 * over a connection (ADR-0557): the key is added there, a redirect is
 * refused, and a request goes only to the endpoint its row was made with.
 */
import type { SendRequest } from '@epicenter/ai/send';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

/** Why an answer that arrived is not a transcript or a completion. */
export const AnswerError = defineErrors({
	Rejected: ({ status, detail }: { status: number; detail: string }) => ({
		message: `The endpoint answered ${status}${detail ? `: ${detail}` : ''}`,
		status,
		detail,
	}),
	Malformed: ({ expected }: { expected: string }) => ({
		message: `The endpoint did not answer with ${expected}`,
		expected,
	}),
	Empty: () => ({ message: 'The endpoint answered with no text' }),
});
export type AnswerError = InferErrors<typeof AnswerError>;

/** A recording's audio as a transcription sends it. */
export type TranscriptionAudio = {
	readonly bytes: Uint8Array;
	readonly filename: string;
	readonly mimeType: string;
};

/** A transcription of `audio` with `model`: a multipart `audio/transcriptions` request. */
export async function transcriptionRequest(
	audio: TranscriptionAudio,
	model: string,
): Promise<SendRequest> {
	const form = new FormData();
	form.append(
		'file',
		new Blob([audio.bytes as Uint8Array<ArrayBuffer>], {
			type: audio.mimeType,
		}),
		audio.filename,
	);
	form.append('model', model);
	form.append('response_format', 'json');
	// A Request serializes the form and names its boundary.
	const encoded = new Request('https://request.invalid/', {
		method: 'POST',
		body: form,
	});
	return {
		method: 'POST',
		path: 'audio/transcriptions',
		headers: [['content-type', encoded.headers.get('content-type') ?? '']],
		body: new Uint8Array(await encoded.arrayBuffer()),
	};
}

/** A chat completion with `prompt` as the system message and `input` as the user's. */
export function transformationRequest({
	model,
	prompt,
	input,
}: {
	model: string;
	prompt: string;
	input: string;
}): SendRequest {
	return {
		method: 'POST',
		path: 'chat/completions',
		headers: [['content-type', 'application/json']],
		body: new TextEncoder().encode(
			JSON.stringify({
				model,
				messages: [
					{ role: 'system', content: prompt },
					{ role: 'user', content: input },
				],
			}),
		),
	};
}

/** The answer's JSON, or why the endpoint refused. At most 300 characters of a refusal are kept. */
async function answered(
	response: Response,
): Promise<Result<unknown, AnswerError>> {
	const body = await response.text().catch(() => '');
	if (!response.ok)
		return AnswerError.Rejected({
			status: response.status,
			detail: body.slice(0, 300).trim(),
		});
	try {
		return Ok(JSON.parse(body));
	} catch {
		return Ok(undefined);
	}
}

/** The transcript text in a transcription answer. */
export async function readTranscription(
	response: Response,
): Promise<Result<{ text: string }, AnswerError>> {
	const { data: answer, error } = await answered(response);
	if (error !== null) return { data: null, error };
	const text = (answer as { text?: unknown } | undefined)?.text;
	return typeof text === 'string'
		? Ok({ text })
		: AnswerError.Malformed({ expected: 'transcript text' });
}

/** The first choice's message text in a chat completion. */
export async function readTransformation(
	response: Response,
): Promise<Result<{ text: string }, AnswerError>> {
	const { data: answer, error } = await answered(response);
	if (error !== null) return { data: null, error };
	const choices = (answer as { choices?: unknown } | undefined)?.choices;
	const message = Array.isArray(choices)
		? (choices[0] as { message?: { content?: unknown } } | undefined)?.message
		: undefined;
	if (typeof message?.content !== 'string')
		return AnswerError.Malformed({ expected: 'a chat completion' });
	if (message.content.trim() === '') return AnswerError.Empty();
	return Ok({ text: message.content });
}
