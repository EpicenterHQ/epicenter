/**
 * How a view asks `epicenter serve` to run an app's actions (ADR-0860,
 * ADR-0864). A view is a web page served from an app's `views/` at
 * `/<app>/`; it asks over MCP like any agent, at the same origin's `/mcp`.
 *
 * ```ts
 * import { connect } from '@epicenter/app/client';
 *
 * const capture = connect('capture');
 * const rows = await capture.call<CaptureRow[]>('captures list');
 * await capture.call('add', { text: 'Fear is the mind-killer.' });
 * ```
 *
 * `call` resolves to what the action returned and rejects with an
 * `ActionError` when it threw or did not run. It imports nothing, so a view's
 * bundle carries only this file.
 */

/** Why a call did not return: the action threw, nothing ran, or the server did not answer. */
export class ActionError extends Error {
	override name = 'ActionError';
	constructor(
		message: string,
		/** `threw` when the action threw, `error` when nothing ran, `transport` when no answer came back. */
		readonly kind: 'threw' | 'error' | 'transport',
		/** The answer's whole object, when there was one: `{ threw }` or `{ error }`. */
		readonly answer?: unknown,
	) {
		super(message);
	}
}

/** An app's actions, asked of the server by their words (`captures list`). */
export type AppClient = {
	readonly app: string;
	call<T = unknown>(words: string, input?: Record<string, unknown>): Promise<T>;
};

let nextId = 1;

/**
 * A client for app `app` on the server at `url`: by default this origin's
 * `/mcp`, where `epicenter serve` answers the views it serves.
 */
export function connect(
	app: string,
	{ url = '/mcp' }: { url?: string } = {},
): AppClient {
	return {
		app,
		async call<T>(words: string, input: Record<string, unknown> = {}) {
			let response: Response;
			try {
				response = await fetch(url, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						accept: 'application/json, text/event-stream',
					},
					body: JSON.stringify({
						jsonrpc: '2.0',
						id: nextId++,
						method: 'tools/call',
						params: {
							name: [app, ...words.trim().split(/\s+/)].join('_'),
							arguments: input,
						},
					}),
				});
			} catch (cause) {
				throw new ActionError(
					`Could not reach Epicenter: ${String(cause)}`,
					'transport',
				);
			}
			if (!response.ok)
				throw new ActionError(
					`Epicenter answered ${response.status} ${response.statusText}`,
					'transport',
				);
			const message = (await response.json()) as {
				result?: {
					isError?: boolean;
					content?: { type: string; text?: string }[];
					structuredContent?: Record<string, unknown>;
				};
				error?: { message: string };
			};
			if (message.error)
				throw new ActionError(message.error.message, 'transport', message);
			const result = message.result ?? {};
			const answer = result.structuredContent ?? {};
			if (!result.isError && 'returned' in answer) return answer.returned as T;
			const text =
				result.content?.find((part) => part.type === 'text')?.text ??
				JSON.stringify(answer);
			throw new ActionError(text, 'threw' in answer ? 'threw' : 'error', answer);
		},
	};
}
