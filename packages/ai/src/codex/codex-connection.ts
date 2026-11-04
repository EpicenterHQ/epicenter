import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import type { CodexConnection, CodexNotification } from './codex-ai.js';

/** Verified against this protocol version; other versions require renewed tool/context checks. */
export const CODEX_REPLY_VERSION = '0.160.1';

/** Opens a dedicated stdio process without inheriting workspace instructions or agent tools. */
export async function openCodexConnection(
	options: { executable?: string } = {},
) {
	const executable = options.executable ?? 'codex';
	const { stdout } = await promisify(execFile)(executable, ['--version'], {
		timeout: 10_000,
	});
	if (stdout.trim() !== `codex-cli ${CODEX_REPLY_VERSION}`)
		throw new Error(
			`Codex replies require verified version ${CODEX_REPLY_VERSION}.`,
		);
	const cwd = await mkdtemp(join(tmpdir(), 'epicenter-codex-reply-'));
	const config: Record<string, string | number | boolean> = {
		project_doc_max_bytes: 0,
		developer_instructions: '',
		include_apps_instructions: false,
		include_permissions_instructions: false,
		include_collaboration_mode_instructions: false,
		include_environment_context: false,
		'skills.include_instructions': false,
		'agents.enabled': false,
		'tools.update_plan.enabled': false,
		'tools.experimental_request_user_input.enabled': false,
		web_search: 'disabled',
		'features.shell_tool': false,
		'features.apps': false,
		'features.plugins': false,
		'features.hooks': false,
		'features.multi_agent': false,
		'features.multi_agent_v2': false,
		'features.browser_use': false,
		'features.computer_use': false,
		'features.image_generation': false,
		'features.code_mode': false,
		'features.code_mode_host': false,
		'features.realtime_conversation': false,
		'features.goals': false,
		'features.sleep_tool': false,
		'features.token_budget': false,
		'features.view_image': false,
		'features.tool_suggest': false,
		'features.remote_plugin': false,
		'features.memories': false,
		'features.request_permissions_tool': false,
	};
	const args = [
		'app-server',
		'--strict-config',
		'-c',
		'mcp_servers={}',
		'-c',
		'plugins={}',
		...Object.entries(config).flatMap(([key, value]) => [
			'-c',
			`${key}=${JSON.stringify(value)}`,
		]),
	];
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			([key]) =>
				!key.startsWith('CODEX_') ||
				key === 'CODEX_HOME' ||
				key === 'CODEX_CA_CERTIFICATE',
		),
	);
	const child = spawn(executable, args, {
		cwd,
		env,
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	const lifetime = new AbortController();
	let counter = 0;
	let disabledServers: Record<string, { enabled: false }> = {};
	let closing: Promise<void> | undefined;
	const pending = new Map<
		number,
		{
			method: string;
			resolve(value: unknown): void;
			reject(cause: unknown): void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	const listeners = new Set<(event: CodexNotification) => void>();
	const attempts = new Set<Promise<void>>();
	// Stderr is drained without publishing prompts, credentials, or protocol payloads.
	child.stderr.resume();
	function retire(cause: unknown) {
		if (lifetime.signal.aborted) return;
		lifetime.abort(cause);
		for (const waiter of pending.values()) {
			clearTimeout(waiter.timer);
			waiter.reject(cause);
		}
		pending.clear();
		child.kill();
	}
	child.on('error', retire);
	child.stdin.on('error', retire);
	const exited = new Promise<void>((resolve) =>
		child.once('close', () => {
			retire(new Error('The Codex process closed.'));
			resolve();
		}),
	);
	const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
	lines.on('line', (line) => {
		if (lifetime.signal.aborted) return;
		try {
			const message: unknown = JSON.parse(line);
			if (!message || typeof message !== 'object' || Array.isArray(message))
				throw new Error('Invalid Codex RPC frame.');
			const frame = message as Record<string, unknown>;
			if (typeof frame.method === 'string') {
				if (frame.id !== undefined) {
					// No server-request capability is admitted by this text-only connection.
					child.stdin.write(
						JSON.stringify({
							id: frame.id,
							error: {
								code: -32601,
								message: 'Unsupported text-reply server request.',
							},
						}) + '\n',
					);
					retire(
						new Error('Codex requested a capability outside text replies.'),
					);
				} else
					for (const listener of listeners)
						listener({ method: frame.method, params: frame.params });
				return;
			}
			if (typeof frame.id !== 'number')
				throw new Error('Invalid Codex RPC response identifier.');
			const waiter = pending.get(frame.id);
			if (!waiter) return;
			pending.delete(frame.id);
			clearTimeout(waiter.timer);
			if (frame.error !== undefined) {
				const cause = new Error(`Codex RPC ${waiter.method} failed.`, {
					cause: frame.error,
				});
				waiter.reject(cause);
				if (
					waiter.method === 'turn/interrupt' ||
					waiter.method === 'thread/unsubscribe'
				) {
					// A failed cleanup must not leave a live turn behind a reusable handle.
					retire(cause);
				}
			} else if ('result' in frame) waiter.resolve(frame.result);
			else waiter.reject(new Error('Codex RPC response has no outcome.'));
		} catch (cause) {
			retire(cause);
		}
	});
	function request(method: string, params: unknown): Promise<unknown> {
		if (lifetime.signal.aborted) return Promise.reject(lifetime.signal.reason);
		if (method === 'thread/start') {
			if (!params || typeof params !== 'object' || Array.isArray(params))
				return Promise.reject(new Error('Invalid Codex thread parameters.'));
			params = {
				...params,
				cwd,
				ephemeral: true,
				approvalPolicy: 'never',
				sandbox: 'read-only',
				developerInstructions: '',
				environments: [],
				selectedCapabilityRoots: [],
				dynamicTools: [],
				config: { ...config, mcp_servers: disabledServers, plugins: {} },
			};
		}
		return new Promise((resolve, reject) => {
			const id = ++counter;
			const timer = setTimeout(() => {
				// Losing a turn-start acknowledgment leaves no safe thread ownership.
				retire(new Error('Codex RPC request timed out.'));
			}, 30_000);
			pending.set(id, { method, resolve, reject, timer });
			child.stdin.write(
				JSON.stringify({ id, method, params }) + '\n',
				(error) => {
					if (error) {
						retire(error);
					}
				},
			);
		});
	}
	const connection = Object.freeze({
		signal: lifetime.signal,
		request,
		subscribe(listener: (event: CodexNotification) => void) {
			lifetime.signal.throwIfAborted();
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		admit() {
			lifetime.signal.throwIfAborted();
			const completion = Promise.withResolvers<void>();
			attempts.add(completion.promise);
			return () => {
				attempts.delete(completion.promise);
				completion.resolve();
			};
		},
		close(): Promise<void> {
			if (closing) return closing;
			const completion = Promise.withResolvers<void>();
			closing = completion.promise;
			retire(new Error('The Codex connection is closed.'));
			void (async () => {
				const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
				try {
					await exited;
				} finally {
					clearTimeout(timeout);
				}
				await Promise.all(attempts);
				listeners.clear();
				lines.close();
				await rm(cwd, { recursive: true, force: true });
			})().then(completion.resolve, completion.reject);
			return closing;
		},
	} satisfies CodexConnection);
	try {
		await request('initialize', {
			clientInfo: { name: 'epicenter_reply', version: '0.0.1' },
			capabilities: { experimentalApi: true },
		});
		child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
		const effective = await request('config/read', { includeLayers: false });
		if (
			!effective ||
			typeof effective !== 'object' ||
			!('config' in effective) ||
			!effective.config ||
			typeof effective.config !== 'object'
		)
			throw new Error('Invalid Codex configuration response.');
		const servers =
			'mcp_servers' in effective.config ? effective.config.mcp_servers : {};
		if (
			servers != null &&
			(typeof servers !== 'object' || Array.isArray(servers))
		)
			throw new Error('Invalid Codex MCP configuration.');
		disabledServers = Object.fromEntries(
			Object.keys(servers ?? {}).map((name) => [
				name,
				{ enabled: false as const },
			]),
		);
		const account = await request('account/read', { refreshToken: false });
		if (
			!account ||
			typeof account !== 'object' ||
			!('requiresOpenaiAuth' in account)
		)
			throw new Error('Invalid Codex account response.');
		if (
			account.requiresOpenaiAuth === true &&
			(!('account' in account) || account.account === null)
		)
			throw new Error('Codex sign-in is required before opening inference.');
		return connection;
	} catch (cause) {
		await connection.close();
		throw cause;
	}
}
