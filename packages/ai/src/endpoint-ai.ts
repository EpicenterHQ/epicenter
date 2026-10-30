import { Ok, type Result } from 'wellcrafted/result';
import type { Inference } from './inference.js';
import {
	type Ai,
	createReplyStream,
	ReplyError,
	type ReplyRequest,
} from './reply.js';

/** Borrows a fixed endpoint; completion vocabulary stays inside the adapter. */
export function createEndpointAi(
	inference: Inference,
	options: { model: string },
) {
	const { model } = options;
	async function* generate(
		request: ReplyRequest,
		signal: AbortSignal,
	): AsyncGenerator<string, Result<string, ReplyError>> {
		let content = '';
		let finish: string | null = null;
		try {
			const stream = await inference.client.chat.completions.create(
				{
					model,
					messages: [
						{ role: 'system', content: request.instructions },
						...request.messages,
					],
					stream: true,
					n: 1,
				},
				{ signal },
			);
			for await (const chunk of stream) {
				if (signal.aborted) return ReplyError.Cancelled();
				if (!Array.isArray(chunk.choices) || chunk.choices.length > 1)
					return ReplyError.Incomplete({ reason: 'invalid reply choices' });
				const choice = chunk.choices[0];
				if (!choice) continue;
				if (
					choice.index !== 0 ||
					(choice.finish_reason != null &&
						typeof choice.finish_reason !== 'string')
				)
					return ReplyError.Incomplete({ reason: 'invalid answer choice' });
				const delta = choice.delta;
				if (
					!delta ||
					(delta.content != null && typeof delta.content !== 'string')
				)
					return ReplyError.Incomplete({ reason: 'invalid text chunk' });
				if (delta.tool_calls?.length || delta.function_call)
					return ReplyError.Incomplete({
						reason: 'tool request instead of text',
					});
				if (delta.refusal)
					return ReplyError.Incomplete({ reason: 'provider refusal' });
				if (choice.finish_reason != null) finish = choice.finish_reason;
				if (delta.content) {
					content += delta.content;
					yield content;
				}
			}
			if (signal.aborted) return ReplyError.Cancelled();
			if (finish !== 'stop')
				return ReplyError.Incomplete({
					reason: finish ?? 'missing completion',
				});
			return Ok(content);
		} catch (cause) {
			return signal.aborted
				? ReplyError.Cancelled()
				: ReplyError.Provider({ cause });
		}
	}
	return Object.freeze({
		reply(request: ReplyRequest) {
			const captured = {
				...request,
				messages: request.messages.map((message) => ({ ...message })),
			};
			return createReplyStream(inference.signal, captured.signal, (signal) =>
				generate(captured, signal),
			);
		},
	} satisfies Ai);
}
