/**
 * One transcription request to an OpenAI-compatible endpoint.
 *
 * Plain `fetch` and nothing else, sent from the browser tab: a custom
 * endpoint must allow requests from the app's origin (CORS), while the
 * account route sends to Epicenter's API.
 *
 * The base URL and key are the transcription connection's (see
 * `connections.ts`). A redirect is refused, not followed, so the key is never
 * carried to another URL, and no ambient credential (a cookie) is sent.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { connectionTargets, type StoredConnection } from './connections.js';
import { refusedBeforeSend } from './request-refusal.js';

export const TranscriptionError = defineErrors({
	NotConfigured: ({ missing }: { missing: string }) => ({
		message: `Transcription is not set up: ${missing} is missing`,
		missing,
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
	AudioUnreadable: ({ reason }: { reason: string }) => ({
		message: `The recording’s audio could not be read: ${reason}`,
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

/** What a transcription sends besides its connection: the audio, and the fetch it goes through. */
export type TranscriptionRequest = {
	readonly audio: {
		readonly bytes: Uint8Array;
		readonly filename: string;
		readonly mimeType: string;
	};
	readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
};

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

/**
 * What the page asks for. It names the transcription connection's base URL it
 * was prepared for, and never a URL to send to: the request goes to the
 * connection's own base URL, with its key, only while that is still
 * `expectedBaseUrl`.
 */
export type PreparedTranscription = {
	/** The recording's audio, read only once the connection is known to be the one prepared for. */
	readonly audio: () => Promise<Result<TranscriptionRequest['audio'], string>>;
	readonly expectedBaseUrl: string;
	readonly model: string;
	/**
	 * The audio's path in the folder (`recordings/<id>.<ext>`), for a platform
	 * that transcribes the file where it is (the desktop's local models).
	 */
	readonly audioPath?: string;
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
	send: NonNullable<TranscriptionRequest['fetch']> = (input, init) =>
		fetch(input, init),
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
	// Past this check the stored base URL is canonical: absolute HTTP(S), with
	// no trailing slash.
	if (!connectionTargets(stored, request.expectedBaseUrl))
		return TranscriptionError.ConnectionChanged({
			expected: request.expectedBaseUrl,
			configured: stored.baseUrl,
		});
	const { data: upload, error: readError } = await request.audio();
	if (readError !== null)
		return TranscriptionError.AudioUnreadable({ reason: readError });
	const model = request.model.trim();
	if (model === '')
		return TranscriptionError.NotConfigured({ missing: 'the model' });

	const url = `${stored.baseUrl}/audio/transcriptions`;
	const apiKey = stored.apiKey ?? '';
	const form = new FormData();
	form.append(
		'file',
		new Blob([upload.bytes as Uint8Array<ArrayBuffer>], {
			type: upload.mimeType,
		}),
		upload.filename,
	);
	form.append('model', model);
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
		});
	} catch (cause) {
		if (refusedBeforeSend(cause))
			return TranscriptionError.ConnectionUnavailable({
				reason: redact(cause.message),
			});
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
