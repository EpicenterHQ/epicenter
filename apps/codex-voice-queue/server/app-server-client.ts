import type { AppServerState } from '../src/lib/api-types.js';
import type {
	RequestId,
	RpcNotification,
	RpcServerRequest,
} from '../src/lib/protocol.js';

export class AppServerError extends Error {
	constructor(
		public code: number,
		message: string,
		public method: string,
		public kind: 'rpc' | 'timeout' | 'disconnected' = 'rpc',
	) {
		super(message);
		this.name = 'AppServerError';
	}
}
export type Transport = {
	stdin: {
		write: (data: string) => unknown;
		flush?: () => unknown;
		end?: () => unknown;
	};
	stdout: ReadableStream<Uint8Array>;
	stderr?: ReadableStream<Uint8Array>;
	exited: Promise<number>;
	kill: () => void;
};
export function spawnAppServer(bin: string): Transport {
	return Bun.spawn([bin, 'app-server'], {
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe',
	});
}
export async function consumeLines(
	stream: ReadableStream<Uint8Array>,
	consume: (line: string) => void,
) {
	let buffer = '';
	for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
		buffer += chunk;
		let newline = buffer.indexOf('\n');
		while (newline !== -1) {
			const line = buffer.slice(0, newline).replace(/\r$/, '');
			buffer = buffer.slice(newline + 1);
			if (line) consume(line);
			newline = buffer.indexOf('\n');
		}
		if (buffer.length > 32 * 1024 * 1024)
			throw new Error('Codex app-server line exceeds 32 MB');
	}
	if (buffer.trim()) consume(buffer);
}
export function createAppServerClient({
	spawnProcess,
	backoffMs = 2000,
	requestTimeoutMs = 60_000,
}: {
	spawnProcess: () => Transport;
	backoffMs?: number;
	requestTimeoutMs?: number;
}) {
	let process: Transport | null = null;
	let state: AppServerState = { state: 'down', lastError: null };
	let starting: Promise<void> | null = null;
	let nextStart = 0;
	let stopped = false;
	let nextId = 0;
	const stderr: string[] = [];
	const notifications = new Set<(notification: RpcNotification) => void>();
	const exits = new Set<() => void>();
	let serverRequest: (request: RpcServerRequest) => Promise<unknown> =
		async () => {
			throw new AppServerError(
				-32601,
				'Not supported by Codex Voice Queue',
				'',
			);
		};
	const pending = new Map<
		RequestId,
		{
			method: string;
			resolve: (value: unknown) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	function log(line: string) {
		stderr.push(line);
		if (stderr.length > 50) stderr.shift();
		console.error(`[app-server] ${line}`);
	}
	function down(child: Transport, error: unknown) {
		if (process !== child) return;
		process = null;
		try {
			child.kill();
		} catch (error) {
			log(`Could not stop app-server: ${String(error)}`);
		}
		state = {
			state: 'down',
			lastError: error instanceof Error ? error.message : String(error),
		};
		nextStart = Date.now() + backoffMs;
		for (const call of pending.values()) {
			clearTimeout(call.timer);
			call.reject(
				new AppServerError(
					-32000,
					state.lastError ?? 'Codex app-server stopped',
					call.method,
					'disconnected',
				),
			);
		}
		pending.clear();
		for (const handler of exits) handler();
	}
	async function write(child: Transport, message: unknown) {
		await child.stdin.write(`${JSON.stringify(message)}\n`);
		await child.stdin.flush?.();
	}
	async function rawRequest<T>(
		child: Transport,
		method: string,
		params: unknown,
		timeoutMs: number,
		onSend?: () => void,
	): Promise<T> {
		const id = ++nextId;
		const response = new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(
					new AppServerError(
						-32000,
						`Timed out waiting for ${method}`,
						method,
						'timeout',
					),
				);
			}, timeoutMs);
			pending.set(id, { method, resolve, reject, timer });
		});
		try {
			onSend?.();
			await write(child, { id, method, params });
		} catch (error) {
			down(child, error);
		}
		return (await response) as T;
	}
	function receive(child: Transport, line: string) {
		if (process !== child) return;
		let message: {
			id?: RequestId;
			method?: string;
			params?: unknown;
			result?: unknown;
			error?: { code: number; message: string };
		};
		try {
			message = JSON.parse(line);
		} catch {
			log(`Ignored non-JSON stdout: ${line.slice(0, 300)}`);
			return;
		}
		if (!message || typeof message !== 'object') {
			log('Ignored non-object stdout');
			return;
		}
		if (message.method && message.id !== undefined) {
			const request = {
				id: message.id,
				method: message.method,
				params: message.params,
			};
			void Promise.resolve()
				.then(() => serverRequest(request))
				.then(
					(result) =>
						process === child
							? write(child, { id: request.id, result })
							: undefined,
					(error) =>
						process === child
							? write(child, {
									id: request.id,
									error: {
										code: error instanceof AppServerError ? error.code : -32000,
										message:
											error instanceof Error ? error.message : String(error),
									},
								})
							: undefined,
				)
				.catch((error) => down(child, error));
		} else if (message.method) {
			for (const handler of notifications) {
				try {
					handler({ method: message.method, params: message.params });
				} catch (error) {
					log(`Notification handler failed: ${String(error)}`);
				}
			}
		} else if (message.id !== undefined) {
			const call = pending.get(message.id);
			if (!call) return;
			pending.delete(message.id);
			clearTimeout(call.timer);
			if (message.error)
				call.reject(
					new AppServerError(
						message.error.code,
						message.error.message,
						call.method,
					),
				);
			else call.resolve(message.result);
		}
	}
	return {
		async ensureReady() {
			if (state.state === 'ready') return;
			if (stopped)
				throw new AppServerError(
					-32000,
					'Codex app-server client is stopped',
					'initialize',
					'disconnected',
				);
			if (starting) return starting;
			if (Date.now() < nextStart)
				throw new AppServerError(
					-32000,
					state.lastError ?? 'Codex app-server restart pending',
					'initialize',
					'disconnected',
				);
			starting = (async () => {
				state = { state: 'starting', lastError: null };
				let child: Transport;
				try {
					child = spawnProcess();
				} catch (error) {
					state = { state: 'down', lastError: String(error) };
					nextStart = Date.now() + backoffMs;
					throw new AppServerError(
						-32000,
						String(error),
						'initialize',
						'disconnected',
					);
				}
				process = child;
				void child.exited.then(
					(code) =>
						down(child, new Error(`Codex app-server stopped (exit ${code})`)),
					(error) => down(child, error),
				);
				void consumeLines(child.stdout, (line) => receive(child, line)).catch(
					(error) => {
						child.kill();
						down(child, error);
					},
				);
				if (child.stderr)
					void consumeLines(child.stderr, log).catch((error) =>
						log(String(error)),
					);
				try {
					await rawRequest(
						child,
						'initialize',
						{
							clientInfo: {
								name: 'codex_voice_queue',
								title: 'Codex Voice Queue',
								version: '0.0.1',
							},
							capabilities: {
								experimentalApi: false,
								requestAttestation: false,
							},
						},
						15_000,
					);
					await write(child, { method: 'initialized' });
					if (process !== child)
						throw new AppServerError(
							-32000,
							'Codex app-server stopped during initialization',
							'initialize',
							'disconnected',
						);
					state = { state: 'ready', lastError: null };
				} catch (error) {
					child.kill();
					down(child, error);
					throw new AppServerError(
						-32000,
						String(error),
						'initialize',
						'disconnected',
					);
				}
			})().finally(() => {
				starting = null;
			});
			return starting;
		},
		async request<T>(
			method: string,
			params: unknown,
			{
				timeoutMs = requestTimeoutMs,
				onSend,
			}: { timeoutMs?: number; onSend?: () => void } = {},
		): Promise<T> {
			await this.ensureReady();
			if (!process)
				throw new AppServerError(
					-32000,
					'Codex app-server is unavailable',
					method,
					'disconnected',
				);
			return rawRequest<T>(process, method, params, timeoutMs, onSend);
		},
		onNotification(handler: (notification: RpcNotification) => void) {
			notifications.add(handler);
			return () => notifications.delete(handler);
		},
		onServerRequest(handler: (request: RpcServerRequest) => Promise<unknown>) {
			serverRequest = handler;
		},
		onExit(handler: () => void) {
			exits.add(handler);
			return () => exits.delete(handler);
		},
		getState() {
			return { ...state };
		},
		getStderr() {
			return [...stderr];
		},
		stop() {
			stopped = true;
			if (process) {
				const child = process;
				child.kill();
				down(child, new Error('Codex app-server stopped'));
			}
		},
	};
}
export type AppServerClient = ReturnType<typeof createAppServerClient>;
