/**
 * One transformation request to an OpenAI-compatible endpoint.
 *
 * A transformation sends its prompt as the system message and the transcript
 * as the user message to `POST <base>/chat/completions`, and reads
 * `choices[0].message.content`. Plain `fetch` and nothing else, sent from the
 * browser tab: a custom endpoint must allow requests from the app's origin
 * (CORS), while the account route sends to Epicenter's API.
 *
 * The base URL and key are the text connection's (see `connections.ts`), read
 * once per request. A redirect is refused, not followed, so the key is never
 * carried to another URL, and no ambient credential (a cookie) is sent.
 *
 * The key never appears in an error: an endpoint that echoes it in a refusal
 * has it removed before the detail is returned.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { connectionTargets, type StoredConnection } from './connections.js';
import { refusedBeforeSend } from './request-refusal.js';

export const TransformationError = defineErrors({
	NotConfigured: ({ missing }: { missing: string }) => ({
		message: `This transformation cannot run: ${missing} is missing`,
		missing,
	}),
	/** The text connection is not set up, or could not be read. Nothing was sent. */
	ConnectionUnavailable: ({ reason }: { reason: string }) => ({
		message: `Nothing was sent: ${reason}`,
		reason,
	}),
	/**
	 * The text connection no longer targets the URL this request was prepared
	 * for. Nothing was sent: a prepared request is never retargeted.
	 */
	ConnectionChanged: ({
		expected,
		configured,
	}: {
		expected: string;
		configured: string;
	}) => ({
		message: `This request was prepared for ${expected}, but the text connection is now ${configured}, so nothing was sent. Run it again to use the current connection.`,
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
	Unreachable: ({ url, reason }: { url: string; reason: string }) => ({
		message: `The endpoint at ${url} could not be reached: ${reason}`,
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
		message: `The endpoint answered ${status}${detail ? `: ${detail}` : ''}`,
		url,
		status,
		detail,
	}),
	Malformed: ({ url }: { url: string }) => ({
		message: `The endpoint at ${url} did not answer with a chat completion`,
		url,
	}),
	Empty: ({ url }: { url: string }) => ({
		message: `The endpoint at ${url} answered with no text`,
		url,
	}),
});
export type TransformationError = InferErrors<typeof TransformationError>;

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

/** The text of the first choice, or undefined when the answer has another shape. */
function firstChoiceText(parsed: unknown): string | undefined {
	if (typeof parsed !== 'object' || parsed === null || !('choices' in parsed))
		return undefined;
	const { choices } = parsed;
	if (!Array.isArray(choices)) return undefined;
	const first: unknown = choices[0];
	if (typeof first !== 'object' || first === null || !('message' in first))
		return undefined;
	const { message } = first;
	if (
		typeof message !== 'object' ||
		message === null ||
		!('content' in message)
	)
		return undefined;
	return typeof message.content === 'string' ? message.content : undefined;
}

/**
 * What the page asks for. It names the text connection's base URL it was
 * prepared for, and never a URL to send to: the request goes to the
 * connection's own base URL, with its key, only while that is still
 * `expectedBaseUrl`.
 */
export type PreparedTransformation = {
	readonly expectedBaseUrl: string;
	readonly model: string;
	/** The system message. */
	readonly prompt: string;
	/** The user message: the transcript text, unchanged. */
	readonly input: string;
};

/**
 * Send a prepared request over the text connection. The connection is read
 * once, here, and that reading is what the request uses to the end: a
 * change saved while it is out does not move it or change its key.
 * `connection` rejects when the connection cannot be read, and resolves to
 * undefined when none is set up; either way nothing is sent.
 */
export async function transformOverConnection(
	connection: () => Promise<StoredConnection | undefined>,
	request: PreparedTransformation,
	send: (input: string, init?: RequestInit) => Promise<Response> = (
		input,
		init,
	) => fetch(input, init),
): Promise<Result<{ text: string }, TransformationError>> {
	let stored: StoredConnection | undefined;
	try {
		stored = await connection();
	} catch (cause) {
		return TransformationError.ConnectionUnavailable({
			reason: describe(cause),
		});
	}
	if (stored === undefined)
		return TransformationError.ConnectionUnavailable({
			reason: 'no text connection is set up. Set one up in Settings.',
		});
	// Past this check the stored base URL is canonical: absolute HTTP(S), with
	// no trailing slash.
	if (!connectionTargets(stored, request.expectedBaseUrl))
		return TransformationError.ConnectionChanged({
			expected: request.expectedBaseUrl,
			configured: stored.baseUrl,
		});
	const { prompt, input } = request;
	const model = request.model.trim();
	if (model === '')
		return TransformationError.NotConfigured({ missing: 'the model' });
	if (prompt.trim() === '')
		return TransformationError.NotConfigured({ missing: 'the prompt' });
	if (input.trim() === '')
		return TransformationError.NotConfigured({ missing: 'the input text' });

	const url = `${stored.baseUrl}/chat/completions`;
	const apiKey = stored.apiKey ?? '';
	const redact = (text: string) =>
		apiKey === '' ? text : text.split(apiKey).join('[key removed]');

	let response: Response;
	try {
		response = await send(url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(apiKey !== '' && { authorization: `Bearer ${apiKey}` }),
			},
			body: JSON.stringify({
				model,
				messages: [
					{ role: 'system', content: prompt },
					{ role: 'user', content: input },
				],
			}),
			// A redirect could carry the key to a URL the connection does not name.
			redirect: 'error',
			credentials: 'omit',
		});
	} catch (cause) {
		if (refusedBeforeSend(cause))
			return TransformationError.ConnectionUnavailable({
				reason: redact(cause.message),
			});
		return TransformationError.Unreachable({
			url,
			reason: redact(describe(cause)),
		});
	}
	const body = await response.text().catch(() => '');
	if (!response.ok)
		return TransformationError.Rejected({
			url,
			status: response.status,
			detail: redact(body).slice(0, 300).trim(),
		});
	let text: string | undefined;
	try {
		text = firstChoiceText(JSON.parse(body));
	} catch {
		// Reported below: an answer that is not the expected JSON is malformed.
	}
	if (text === undefined) return TransformationError.Malformed({ url });
	if (text.trim() === '') return TransformationError.Empty({ url });
	return Ok({ text });
}
