/**
 * Requests to a model, and how their failures read.
 *
 * Where a request goes is a target: the endpoint and model the person chose,
 * captured when the request is prepared, with the endpoint's name and its
 * address (its base URL, or its id for an engine inside the app) as they were
 * then. A request is sent through the endpoints merged now (`openAi`), to that
 * endpoint alone and only while it is still at that address: an endpoint
 * removed or moved since is reported by name, and nothing falls back to
 * another.
 *
 * A failure says what is known. Refused before sending (the shell refused it,
 * or no one is signed in) is certain; an endpoint that never answered is not:
 * the request may have gone and its answer been lost, so the outcome is
 * unknown, and nothing is sent again without the person asking. Keys never
 * reach a message: an endpoint removes its key from any refusal it reads.
 */
import type { Ai, AiError } from '@epicenter/ai';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import { refusedBeforeSend } from './request-refusal.js';
import { sentences } from './sentences.js';

/** Where a prepared request goes: an endpoint and a model, as they were when it was prepared. */
export type Target = {
	/** The endpoint's id in the merge. */
	readonly endpoint: string;
	readonly model: string;
	/** What a person calls the endpoint. */
	readonly name: string;
	/** Where its requests went when this was prepared; a result names it. */
	readonly address: string;
};

/** Where `endpoint`'s requests go: its base URL, or its id for an engine inside the app. */
export const addressOf = (endpoint: { id: string; baseUrl?: string }) =>
	endpoint.baseUrl ?? endpoint.id;

export const InferenceError = defineErrors({
	/** The target's endpoint is no longer merged: its connection was removed. Nothing was sent. */
	EndpointGone: ({ name }: { name: string }) => ({
		message: `${name} is no longer set up, so nothing was sent. Choose a model in Settings and run it anew.`,
	}),
	/** The target's endpoint now sends somewhere else. Nothing was sent: a prepared request is never retargeted. */
	EndpointMoved: ({
		name,
		expected,
		now,
	}: {
		name: string;
		expected: string;
		now: string;
	}) => ({
		message: `${name} changed from ${expected} to ${now} while this was being prepared, so nothing was sent. Try again to send it to ${name} as it is now.`,
		expected,
		now,
	}),
	/** Something certain stopped the request before it left. */
	NotSent: ({ reason }: { reason: string }) => ({
		message: `Nothing was sent: ${reason}`,
		reason,
	}),
	/**
	 * No answer arrived. That says nothing about what the endpoint did: it may
	 * never have been reached, or it may have taken the request and had its
	 * answer lost on the way back.
	 */
	OutcomeUnknown: ({ name, reason }: { name: string; reason: string }) => ({
		message: sentences(
			`${name} did not answer, so it is not known whether the request was sent or what came back: ${reason}`,
			'Nothing is sent again unless you try again.',
		),
		reason,
	}),
	/** The endpoint answered with a refusal. */
	Rejected: ({
		name,
		status,
		detail,
	}: {
		name: string;
		status: number;
		detail: string;
	}) => ({
		message: `${name} answered ${status}${detail ? `: ${detail}` : ''}`,
		status,
		detail,
	}),
	/** The endpoint reported an error while it answered. */
	Failed: ({ name, detail }: { name: string; detail: string }) => ({
		message: `${name} stopped with an error: ${detail}`,
		detail,
	}),
	/** The answer did not read as the request's answer. */
	Malformed: ({ name, reason }: { name: string; reason: string }) => ({
		message: `${name}’s answer did not read: ${reason}`,
		reason,
	}),
});
export type InferenceError = InferErrors<typeof InferenceError>;

/** The recording's audio, as a file is uploaded. */
export type Audio = {
	readonly bytes: Uint8Array;
	/** The file's name, as the request names it. */
	readonly name: string;
	readonly mimeType: string;
};

/** The endpoints merged now, read at the moment a request is sent. */
export type CurrentAi = () => Pick<Ai, 'endpoints' | 'transcribe'>;

/** Why `target` cannot be sent through `ai` now, or undefined when it can. */
function moved(
	ai: ReturnType<CurrentAi>,
	target: Target,
): InferenceError | undefined {
	const now = ai.endpoints().find(({ id }) => id === target.endpoint);
	if (!now) return InferenceError.EndpointGone({ name: target.name }).error;
	if (addressOf(now) !== target.address)
		return InferenceError.EndpointMoved({
			name: target.name,
			expected: target.address,
			now: addressOf(now),
		}).error;
	return undefined;
}

/** What a client's failure says about the request, in Whispering's words. */
function failureOf(target: Target, error: AiError): InferenceError {
	switch (error.name) {
		case 'NoEndpoint':
			return InferenceError.EndpointGone({ name: target.name }).error;
		case 'Unreachable': {
			const reason = refusedBeforeSend((error as { cause: unknown }).cause);
			if (reason !== undefined) return InferenceError.NotSent({ reason }).error;
			return InferenceError.OutcomeUnknown({
				name: target.name,
				reason: error.message,
			}).error;
		}
		case 'Cancelled':
			return InferenceError.OutcomeUnknown({
				name: target.name,
				reason: error.message,
			}).error;
		case 'Refused':
			return InferenceError.Rejected({
				name: target.name,
				status: error.status,
				detail: error.message.slice(0, 300).trim(),
			}).error;
		case 'Failed':
			return InferenceError.Failed({
				name: target.name,
				detail: error.message,
			}).error;
		case 'Malformed':
			return InferenceError.Malformed({
				name: target.name,
				reason: error.reason,
			}).error;
	}
}

/**
 * Transcribe `audio` at `target`, through the endpoints merged now: an
 * endpoint removed or moved since `target` was prepared is not sent to.
 * It never throws: a request that throws leaves the outcome unknown.
 */
export async function transcribeAt(
	current: CurrentAi,
	target: Target,
	audio: Audio,
): Promise<Result<{ text: string }, InferenceError>> {
	const ai = current();
	const gone = moved(ai, target);
	if (gone) return Err(gone);
	const file = new File([audio.bytes as Uint8Array<ArrayBuffer>], audio.name, {
		type: audio.mimeType,
	});
	const sent = await tryAsync({
		try: () =>
			ai.transcribe({ endpoint: target.endpoint, model: target.model, file }),
		catch: (cause) =>
			InferenceError.OutcomeUnknown({
				name: target.name,
				reason: extractErrorMessage(cause),
			}),
	});
	if (sent.error !== null) return sent;
	const { data, error } = sent.data;
	if (error !== null) return Err(failureOf(target, error));
	return Ok({ text: data.text.trim() });
}
