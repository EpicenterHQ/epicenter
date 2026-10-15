/**
 * One transcription request to an OpenAI-compatible endpoint.
 *
 * Plain `fetch` and nothing else. A browser tab sends it itself; inside
 * Epicenter the `fetch` goes through the `epicenter` command, which adds the
 * key from the keychain, so the key stays out of the page and the endpoint
 * needs no CORS headers.
 *
 * The base URL and key are the transcription connection's (see
 * `connections.ts`). A redirect is refused, not followed, so the key is never
 * carried to another URL, and no ambient credential (a cookie) is sent.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import {
	canonicalBaseUrl,
	connectionTargets,
	type StoredConnection,
} from './connections.js';

export const TranscriptionError = defineErrors({
	NotConfigured: ({ missing }: { missing: string }) => ({
		message: `Transcription is not set up: ${missing} is missing`,
		missing,
	}),
	InvalidEndpoint: ({ reason }: { reason: string }) => ({
		message: `Transcription cannot run: ${reason}`,
		reason,
	}),
	/** The transcription connection is not set up, or could not be read. Nothing was sent. */
	ConnectionUnavailable: ({ reason }: { reason: string }) => ({
		message: `Nothing was sent: ${reason}`,
		reason,
	}),
	/**
	 * The transcription connection no longer targets the URL this request was
	 * prepared for. Nothing was sent: a prepared request is never retargeted.
	 */
	ConnectionChanged: ({
		expected,
		configured,
	}: {
		expected: string;
		configured: string;
	}) => ({
		message: `This request was prepared for ${expected}, but the transcription connection is now ${configured}, so nothing was sent. Transcribe again to use the current connection.`,
		expected,
		configured,
	}),
	/**
	 * Epicenter did not answer, or its answer never arrived. That says nothing
	 * about what it did: it may never have been reached, or it may have sent
	 * the request and had its answer lost on the way back. The outcome is
	 * unknown, and nothing is sent again without the person asking.
	 */
	HostUnavailable: ({ reason }: { reason: string }) => ({
		message: `Epicenter did not answer, so it is not known whether the request was sent or what came back: ${reason}. Nothing is sent again unless you try again.`,
		reason,
	}),
	/** The audio was not read, so no request was made. This one is certain. */
	AudioUnreadable: ({ path, reason }: { path: string; reason: string }) => ({
		message: `The audio at '${path}' could not be read: ${reason}`,
		path,
		reason,
	}),
	Unreachable: ({ url, reason }: { url: string; reason: string }) => ({
		message: `The transcription endpoint at ${url} could not be reached: ${reason}`,
		url,
		reason,
	}),
	Rejected: ({
		url,
		status,
		detail,
	}: {
		url: string;
		status: number;
		detail: string;
	}) => ({
		message: `The transcription endpoint answered ${status}${detail ? `: ${detail}` : ''}`,
		url,
		status,
		detail,
	}),
	Malformed: ({ url }: { url: string }) => ({
		message: `The transcription endpoint at ${url} did not answer with transcript text`,
		url,
	}),
	/** Epicenter's local model ran and failed: it did not load, or inference failed. */
	LocalFailed: ({ reason }: { reason: string }) => ({
		message: `Transcription on this computer failed: ${reason}`,
		reason,
	}),
});
export type TranscriptionError = InferErrors<typeof TranscriptionError>;

export type TranscriptionRequest = {
	readonly baseUrl: string;
	readonly model: string;
	/** Sent as a bearer credential when nonempty. A local endpoint may need none. */
	readonly apiKey: string;
	readonly audio: {
		readonly bytes: Uint8Array;
		readonly filename: string;
		readonly mimeType: string;
	};
	readonly signal?: AbortSignal;
	readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
};

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

export function transcriptionUrl(baseUrl: string): string {
	return `${baseUrl.trim().replace(/\/+$/, '')}/audio/transcriptions`;
}

export async function requestTranscription({
	baseUrl,
	model,
	apiKey,
	audio,
	signal,
	fetch: send = (input, init) => fetch(input, init),
}: TranscriptionRequest): Promise<
	Result<{ text: string }, TranscriptionError>
> {
	if (baseUrl.trim() === '')
		return TranscriptionError.NotConfigured({ missing: 'the endpoint URL' });
	const { data: base, error: urlError } = canonicalBaseUrl(baseUrl);
	if (urlError !== null)
		return TranscriptionError.InvalidEndpoint({ reason: urlError });
	if (model.trim() === '')
		return TranscriptionError.NotConfigured({ missing: 'the model' });
	const url = transcriptionUrl(base);
	const form = new FormData();
	form.append(
		'file',
		new Blob([audio.bytes as Uint8Array<ArrayBuffer>], {
			type: audio.mimeType,
		}),
		audio.filename,
	);
	form.append('model', model.trim());
	form.append('response_format', 'json');

	// An endpoint that echoes the key in a refusal must not carry it to the page.
	const redact = (text: string) =>
		apiKey === '' ? text : text.split(apiKey).join('[key removed]');

	let response: Response;
	try {
		response = await send(url, {
			method: 'POST',
			headers: apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` },
			body: form,
			// A redirect could carry the key to a URL the connection does not name.
			redirect: 'error',
			credentials: 'omit',
			signal,
		});
	} catch (cause) {
		return TranscriptionError.Unreachable({
			url,
			reason: redact(describe(cause)),
		});
	}
	const body = await response.text().catch(() => '');
	if (!response.ok)
		return TranscriptionError.Rejected({
			url,
			status: response.status,
			detail: redact(body).slice(0, 300).trim(),
		});
	try {
		const parsed: unknown = JSON.parse(body);
		if (
			typeof parsed === 'object' &&
			parsed !== null &&
			'text' in parsed &&
			typeof parsed.text === 'string'
		)
			return Ok({ text: parsed.text });
	} catch {
		// Reported below: an answer that is not the expected JSON is malformed.
	}
	return TranscriptionError.Malformed({ url });
}

/**
 * What the page asks for. It names the transcription connection's base URL it
 * was prepared for, and never a URL to send to: the request goes to the
 * connection's own base URL, with its key, only while that is still
 * `expectedBaseUrl`.
 */
export type PreparedTranscription = {
	readonly audioPath: string;
	readonly expectedBaseUrl: string;
	readonly model: string;
};

/**
 * Send a recording's audio over the transcription connection. The connection
 * is read once, here, before the audio, and that reading is what the request
 * uses to the end. `connection` rejects when it cannot be read and resolves
 * to undefined when none is set up; audio that cannot be read is the same
 * certain case. Either way nothing is sent.
 */
export async function transcribeOverConnection(
	connection: () => Promise<StoredConnection | undefined>,
	request: PreparedTranscription,
	audio: () => Promise<Result<TranscriptionRequest['audio'], string>>,
	send?: TranscriptionRequest['fetch'],
): Promise<Result<{ text: string }, TranscriptionError>> {
	let stored: StoredConnection | undefined;
	try {
		stored = await connection();
	} catch (cause) {
		return TranscriptionError.ConnectionUnavailable({
			reason: describe(cause),
		});
	}
	if (stored === undefined)
		return TranscriptionError.ConnectionUnavailable({
			reason: 'no transcription connection is set up. Set one up in Settings.',
		});
	if (!connectionTargets(stored, request.expectedBaseUrl))
		return TranscriptionError.ConnectionChanged({
			expected: request.expectedBaseUrl,
			configured: stored.baseUrl,
		});
	const { data: upload, error: readError } = await audio();
	if (readError !== null)
		return TranscriptionError.AudioUnreadable({
			path: request.audioPath,
			reason: readError,
		});
	return requestTranscription({
		baseUrl: stored.baseUrl,
		apiKey: stored.apiKey ?? '',
		model: request.model,
		audio: upload,
		fetch: send,
	});
}
