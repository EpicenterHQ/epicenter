import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import type { Result } from 'wellcrafted/result';

const log = createLogger('ai/reply');

export const ReplyError = defineErrors({
	Cancelled: () => ({ message: 'The reply attempt was cancelled.' }),
	Closed: () => ({ message: 'The inference resource is closed.' }),
	Incomplete: ({ reason }: { reason: string }) => ({
		message: `The provider did not complete a text answer: ${reason}`,
	}),
	Provider: ({ cause }: { cause: unknown }) => ({
		message: 'The reply provider failed.',
		cause,
	}),
	Unsupported: ({ reason }: { reason: string }) => ({
		message: `The reply provider is unsupported: ${reason}`,
	}),
});
export type ReplyError = InferErrors<typeof ReplyError>;

export type ReplyRequest = {
	instructions: string;
	messages: readonly { role: 'user' | 'assistant'; content: string }[];
	signal: AbortSignal;
};
export type ReplyEvent =
	| { type: 'preview'; text: string }
	| { type: 'result'; result: Result<string, ReplyError> };
export type Ai = {
	reply(request: ReplyRequest): AsyncIterable<ReplyEvent>;
};

/** Iterator closure cancels immediately, including while an earlier next is pending. */
export function createReplyStream(
	owner: AbortSignal,
	request: AbortSignal,
	generate: (
		signal: AbortSignal,
	) => AsyncGenerator<string, Result<string, ReplyError>>,
): AsyncIterableIterator<ReplyEvent> {
	const controller = new AbortController();
	const signal = AbortSignal.any([owner, request, controller.signal]);
	const stopped = Promise.withResolvers<void>();
	let inner: ReturnType<typeof generate> | undefined;
	let finished = false;
	let tail = Promise.resolve();
	const cancelled = () =>
		owner.aborted ? ReplyError.Closed() : ReplyError.Cancelled();
	function stop() {
		stopped.resolve();
		// Provider generators handle transport failures and cleanup in their own finally.
		void inner
			?.return(cancelled())
			.catch((cause) => log.warn(ReplyError.Provider({ cause }).error));
	}
	signal.addEventListener('abort', stop, { once: true });
	if (signal.aborted) stop();
	function finish() {
		finished = true;
		signal.removeEventListener('abort', stop);
	}
	async function next(): Promise<IteratorResult<ReplyEvent>> {
		if (finished) return { done: true, value: undefined };
		if (signal.aborted) {
			finish();
			return { done: false, value: { type: 'result', result: cancelled() } };
		}
		inner ??= generate(signal);
		try {
			const step = await Promise.race([inner.next(), stopped.promise]);
			if (finished) return { done: true, value: undefined };
			if (signal.aborted || step === undefined) {
				finish();
				return { done: false, value: { type: 'result', result: cancelled() } };
			}
			if (step.done) {
				finish();
				return { done: false, value: { type: 'result', result: step.value } };
			}
			return { done: false, value: { type: 'preview', text: step.value } };
		} catch (error) {
			finish();
			if (signal.aborted)
				return { done: false, value: { type: 'result', result: cancelled() } };
			throw error;
		}
	}
	return {
		[Symbol.asyncIterator]() {
			return this;
		},
		next() {
			const step = tail.then(next);
			tail = step.then(
				() => undefined,
				() => undefined,
			);
			return step;
		},
		async return() {
			finish();
			controller.abort();
			stop();
			return { done: true, value: undefined };
		},
	};
}
