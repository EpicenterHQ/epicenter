import type { RequestId } from '../../src/lib/protocol.js';
import type { Transport } from '../app-server-client.js';

export type FakeMessage = {
	id?: RequestId;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string };
};
export function createFakeAppServer({
	onRequest,
}: {
	onRequest?: (message: FakeMessage) => unknown | Promise<unknown>;
} = {}) {
	let output: ReadableStreamDefaultController<Uint8Array>;
	let errors: ReadableStreamDefaultController<Uint8Array>;
	let exit: (code: number) => void = () => {};
	let closed = false;
	const messages: FakeMessage[] = [];
	const encoder = new TextEncoder();
	function send(message: unknown) {
		if (!closed) output.enqueue(encoder.encode(`${JSON.stringify(message)}\n`));
	}
	function finish(code: number) {
		if (closed) return;
		closed = true;
		output.close();
		errors.close();
		exit(code);
	}
	const transport: Transport = {
		stdout: new ReadableStream({
			start(controller) {
				output = controller;
			},
		}),
		stderr: new ReadableStream({
			start(controller) {
				errors = controller;
			},
		}),
		stdin: {
			write(data) {
				for (const line of data.trim().split('\n')) {
					const message: FakeMessage = JSON.parse(line);
					messages.push(message);
					if (message.method === 'initialize')
						send({ id: message.id, result: { userAgent: 'fake' } });
					else if (message.method && message.id !== undefined && onRequest)
						void Promise.resolve()
							.then(() => onRequest(message))
							.then(
								(result) => send({ id: message.id, result }),
								(error) =>
									send({
										id: message.id,
										error: { code: -32000, message: String(error) },
									}),
							);
				}
			},
			flush() {},
		},
		exited: new Promise((resolve) => {
			exit = resolve;
		}),
		kill() {
			finish(0);
		},
	};
	return {
		transport,
		messages,
		send,
		chunks(parts: string[]) {
			for (const part of parts) output.enqueue(encoder.encode(part));
		},
		notify(method: string, params: unknown) {
			send({ method, params });
		},
		ask(id: RequestId, method: string, params: unknown) {
			send({ id, method, params });
		},
		exit: finish,
	};
}
export async function waitFor(predicate: () => boolean) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await Bun.sleep(2);
	}
	throw new Error('Fake app-server expectation timed out');
}
