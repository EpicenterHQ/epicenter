/** Reply adapters certify complete answers and promptly stop pending reads without closing borrowed resources. */
import { expect, test } from 'bun:test';
import { unwrap } from 'wellcrafted/result';
import { createEndpointAi } from './endpoint-ai.js';
import { createInference } from './inference.js';
import type { ReplyEvent } from './reply.js';

const signal = new AbortController().signal;
const request = {
	instructions: 'Tutor instructions',
	messages: [{ role: 'user' as const, content: 'Hello' }],
	signal,
};
const encode = (delta: object, finish_reason: string | null = null) =>
	`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
const response = (body: string) =>
	new Response(body, { headers: { 'content-type': 'text/event-stream' } });
const result = (events: ReplyEvent[]) => {
	const last = events.at(-1);
	if (last?.type !== 'result') throw new Error('No terminal reply result');
	return last.result;
};

test('reuses an endpoint and preserves role history while returning replacement previews and canonical text', async () => {
	const sent: unknown[] = [];
	const inference = createInference({
		baseURL: 'https://inference.test/v1',
		async fetch(_input, init) {
			sent.push(JSON.parse(String(init?.body)));
			return response(
				encode({ content: '你' }) +
					encode({ content: '好' }, 'stop') +
					'data: [DONE]\n\n',
			);
		},
	});
	try {
		const ai = createEndpointAi(inference, { model: 'chosen' });
		const events = await Array.fromAsync(ai.reply(request));
		expect(events.slice(0, 2)).toEqual([
			{ type: 'preview', text: '你' },
			{ type: 'preview', text: '你好' },
		]);
		expect(unwrap(result(events))).toBe('你好');
		expect(
			unwrap(
				result(await Array.fromAsync(ai.reply({ ...request, messages: [] }))),
			),
		).toBe('你好');
		expect(sent).toEqual([
			{
				model: 'chosen',
				messages: [
					{ role: 'system', content: request.instructions },
					...request.messages,
				],
				stream: true,
				n: 1,
			},
			{
				model: 'chosen',
				messages: [{ role: 'system', content: request.instructions }],
				stream: true,
				n: 1,
			},
		]);
		expect(inference.signal.aborted).toBe(false);
	} finally {
		await inference.close();
	}
});

for (const [name, wire] of [
	['missing completion', encode({ content: 'partial' })],
	['truncation', encode({ content: 'partial' }, 'length')],
	[
		'tools',
		encode(
			{
				tool_calls: [
					{
						id: 'call',
						type: 'function',
						function: { name: 'shell', arguments: '{}' },
					},
				],
			},
			'tool_calls',
		),
	],
	['refusal', encode({ refusal: 'No' }, 'stop')],
	[
		'invalid choice index',
		'data: {"choices":[{"index":-1,"delta":{"content":"wrong"},"finish_reason":"stop"}]}\n\n',
	],
] as const)
	test(`does not certify ${name} as a saved answer`, async () => {
		const inference = createInference({
			baseURL: 'https://inference.test/v1',
			async fetch() {
				return response(wire + 'data: [DONE]\n\n');
			},
		});
		try {
			const events = await Array.fromAsync(
				createEndpointAi(inference, { model: 'chosen' }).reply(request),
			);
			expect(result(events).error?.name).toBe('Incomplete');
		} finally {
			await inference.close();
		}
	});

test('iterator return settles a pending header read and aborts it without retiring the owner', async () => {
	const started = Promise.withResolvers<void>();
	const headers = Promise.withResolvers<Response>();
	let sentSignal: AbortSignal | undefined;
	const inference = createInference({
		baseURL: 'https://inference.test/v1',
		async fetch(_input, init) {
			sentSignal = init?.signal ?? undefined;
			started.resolve();
			return headers.promise;
		},
	});
	const iterator = createEndpointAi(inference, { model: 'chosen' }).reply(
		request,
	);
	const pending = iterator.next();
	await started.promise;
	await iterator.return!();
	const timeout = setTimeout(() => headers.resolve(response('')), 1000);
	try {
		expect((await pending).done).toBe(true);
		expect(sentSignal?.aborted).toBe(true);
		expect(inference.signal.aborted).toBe(false);
	} finally {
		clearTimeout(timeout);
		headers.resolve(response(''));
		await inference.close();
	}
});

test('owner retirement produces a terminal closed error before an abort-ignoring fetch returns', async () => {
	const started = Promise.withResolvers<void>();
	const headers = Promise.withResolvers<Response>();
	const inference = createInference({
		baseURL: 'https://inference.test/v1',
		async fetch() {
			started.resolve();
			return headers.promise;
		},
	});
	const ai = createEndpointAi(inference, { model: 'chosen' });
	const iterator = ai.reply(request);
	const pending = iterator.next();
	await started.promise;
	const closing = inference.close();
	const timeout = setTimeout(() => headers.resolve(response('')), 1000);
	try {
		const step = await pending;
		expect(step.value).toMatchObject({
			type: 'result',
			result: { error: { name: 'Closed' } },
		});
		expect(result(await Array.fromAsync(ai.reply(request))).error?.name).toBe(
			'Closed',
		);
	} finally {
		clearTimeout(timeout);
		headers.resolve(response(''));
		await closing;
	}
});

test('request cancellation suppresses a late complete response and leaves the endpoint reusable', async () => {
	const started = Promise.withResolvers<void>();
	const headers = Promise.withResolvers<Response>();
	const controller = new AbortController();
	const inference = createInference({
		baseURL: 'https://inference.test/v1',
		async fetch() {
			started.resolve();
			return headers.promise;
		},
	});
	const iterator = createEndpointAi(inference, { model: 'chosen' }).reply({
		...request,
		signal: controller.signal,
	});
	const pending = iterator.next();
	await started.promise;
	controller.abort();
	try {
		expect((await pending).value).toMatchObject({
			type: 'result',
			result: { error: { name: 'Cancelled' } },
		});
		headers.resolve(
			response(encode({ content: 'late' }, 'stop') + 'data: [DONE]\n\n'),
		);
		expect((await iterator.next()).done).toBe(true);
		expect(inference.signal.aborted).toBe(false);
	} finally {
		headers.resolve(response(''));
		await inference.close();
	}
});

test('captures model options at construction and transcript content when reply is called', async () => {
	let sent: unknown;
	const inference = createInference({
		baseURL: 'https://inference.test/v1',
		async fetch(_input, init) {
			sent = JSON.parse(String(init?.body));
			return response(
				encode({ content: 'answer' }, 'stop') + 'data: [DONE]\n\n',
			);
		},
	});
	const options = { model: 'initial' };
	const mutable = {
		...request,
		messages: [{ role: 'user' as const, content: 'original' }],
	};
	const stream = createEndpointAi(inference, options).reply(mutable);
	options.model = 'changed';
	mutable.instructions = 'changed';
	mutable.messages[0]!.content = 'changed';
	try {
		expect(unwrap(result(await Array.fromAsync(stream)))).toBe('answer');
		expect(sent).toMatchObject({
			model: 'initial',
			messages: [
				{ role: 'system', content: 'Tutor instructions' },
				{ role: 'user', content: 'original' },
			],
		});
	} finally {
		await inference.close();
	}
});
