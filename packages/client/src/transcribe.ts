/**
 * `transcribe`: the one OpenAI-compatible speech-to-text client (ADR-0050/0056/0060).
 *
 * Transcription is a service: it holds nothing and sees only the audio blob you
 * hand it. So there is one wire (`POST {baseURL}/audio/transcriptions`, multipart
 * `file`, where the connection's `baseURL` already carries `/v1`) reached through
 * the same {@link ResolvedConnection} transport that drives chat, and zero
 * per-provider adapters. OpenAI, Groq, and a self-hosted Speaches box are not three
 * code paths; they are three connections, each `resolveConnection`d to a transport
 * and handed to the same function.
 *
 * Like `listModels` and the chat engine, this consumes the *resolved* transport
 * (`{ fetch, baseURL }`), not the static `Connection`.
 * `resolveConnection` is the single boundary that turns connection data into a
 * transport, and the caller crosses it: a third-party connection resolves its own
 * key into a Bearer, and the hosted Epicenter path injects its audience-scoped
 * session fetch (ADR-0053/0060), which is never connection data. So this client
 * never re-resolves and never branches on what kind of transport it got.
 *
 * Deepgram and ElevenLabs stay bespoke in their own clients: they do not speak
 * this wire (Deepgram takes a raw body under `Authorization: Token`, ElevenLabs an
 * `xi-api-key` with `model_id`), and ADR-0060 blesses that exception. Whispering's
 * in-process `transcribe-rs` engine also stays its own path: it is `invoke` over
 * the Tauri FFI, a privileged non-wire sibling, not a `Connection`.
 *
 * This is `apps/whispering/.../self-hosted/speaches.ts` generalized: the name
 * dropped and the bespoke config replaced by a transport. The error stays lean
 * and structured (it carries the HTTP `status`); an app maps a status to its own
 * user-facing copy at its toast/query layer, the library does not own that copy.
 */

import { blobInputContentType, selectBlobFormat } from '@epicenter/blobs';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import { joinUrl, type ResolvedConnection } from './connection.js';

/**
 * The transcription request, minus the audio and the connection. `model` is
 * required because the wire never defaults it; `language` (an ISO-639-1 hint) and
 * `prompt` (a vocabulary/style hint) are optional, omitted from the form when
 * absent so a server's own defaults apply.
 */
type TranscribeOptions = {
	model: string;
	language?: string;
	prompt?: string;
};

export const TranscribeError = defineErrors({
	/** The transport itself failed: network down, DNS, aborted, CORS, an FFI throw. */
	TransportFailed: ({ cause }: { cause: unknown }) => ({
		message: `Could not reach the transcription endpoint: ${extractErrorMessage(cause)}`,
		cause,
	}),
	/**
	 * The request reached a server but returned a non-2xx status. `status` and
	 * `detail` are carried so a consumer can branch (401 -> bad key, 413 -> too
	 * large) and surface its own copy.
	 */
	RequestFailed: ({ status, detail }: { status: number; detail?: string }) => ({
		message: `Transcription failed (${status})${detail ? `: ${detail}` : ''}`,
		status,
		detail,
	}),
	/** A 2xx body that was not the OpenAI `{ text: string }` shape. */
	Malformed: () => ({
		message: 'The transcription response was not an OpenAI { text } body.',
	}),
});
export type TranscribeError = InferErrors<typeof TranscribeError>;

/**
 * Transcribe an audio blob over the OpenAI wire. Takes the resolved transport
 * (`{ fetch, baseURL }`, see {@link ResolvedConnection}), POSTs a multipart form,
 * and returns the trimmed transcript text or a typed {@link TranscribeError}.
 * Never throws.
 *
 * The shared blob format policy selects the upload filename from the producer's
 * type or, for an untyped File, its filename. Unknown bytes keep a .bin suffix.
 */
export async function transcribe(
	audio: Blob,
	{ fetch, baseURL }: ResolvedConnection,
	{ model, language, prompt }: TranscribeOptions,
): Promise<Result<string, TranscribeError>> {
	const form = new FormData();
	form.append(
		'file',
		new File([audio], `audio.${selectBlobFormat(audio).extension}`, {
			type: blobInputContentType(audio),
		}),
	);
	form.append('model', model);
	if (language) form.append('language', language);
	if (prompt) form.append('prompt', prompt);

	const { data: response, error: transportError } = await tryAsync({
		try: () =>
			fetch(joinUrl(baseURL, 'audio/transcriptions'), {
				method: 'POST',
				body: form,
			}),
		catch: (cause) => TranscribeError.TransportFailed({ cause }),
	});
	if (transportError) return Err(transportError);

	if (!response.ok) {
		const detail = (await response.text().catch(() => '')).slice(0, 200);
		return TranscribeError.RequestFailed({ status: response.status, detail });
	}

	const { data: body, error: parseError } = await tryAsync({
		try: () => response.json() as Promise<unknown>,
		catch: () => TranscribeError.Malformed(),
	});
	if (parseError) return Err(parseError);

	const text = extractText(body);
	if (text === null) return TranscribeError.Malformed();
	return Ok(text.trim());
}

/** Pull `text` out of an OpenAI `{ text: string }` body, or null if the shape is wrong. */
function extractText(body: unknown): string | null {
	if (
		typeof body === 'object' &&
		body !== null &&
		'text' in body &&
		typeof (body as { text: unknown }).text === 'string'
	)
		return (body as { text: string }).text;
	return null;
}
