#!/usr/bin/env bun

import { spawn, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
	assertDelegateWorkspace,
	resolveSkillWriteRoots,
} from './workspace.js';

/**
 * The host fixes access, workspace, model and limits. Claude supplies a bounded
 * assignment and can resume helper sessions created by this connection.
 */
export function createCodexAssistance({
	source,
	cwd,
	mode,
	model,
	maxCalls = 4,
	timeoutMs = 300_000,
	writeRoots = [],
}: {
	source: string;
	cwd: string;
	mode: 'consult' | 'delegate';
	model: string;
	maxCalls?: number;
	timeoutMs?: number;
	writeRoots?: string[];
}) {
	source = realpathSync(source);
	cwd = realpathSync(cwd);
	if (mode === 'delegate') assertDelegateWorkspace(source, cwd);
	else if (cwd !== source)
		throw new Error('Evidence must use the assigned source checkout.');
	if (mode !== 'delegate' && writeRoots.length)
		throw new Error('Skill write roots require delegate mode.');
	const skillWriteRoots = resolveSkillWriteRoots(cwd, writeRoots);
	if (!model.trim()) throw new Error('Codex model must not be empty.');
	for (const value of [maxCalls, timeoutMs])
		if (!Number.isSafeInteger(value) || value < 1)
			throw new Error('Codex limits must be positive integers.');

	const env = { ...process.env };
	for (const key of [
		'OPENAI_API_KEY',
		'CODEX_API_KEY',
		'OPENAI_BASE_URL',
		'CODEX_THREAD_ID',
	])
		delete env[key];
	const sessions = new Map<string, string>();
	let calls = 0;
	let stop: (() => void) | undefined;
	let authenticated = false;
	const inputSchema = {
		type: 'object' as const,
		properties: {
			prompt: {
				type: 'string',
				minLength: 1,
				maxLength: 24_000,
				description:
					'Bounded assignment, required evidence and stop condition.',
			},
			session_id: {
				type: 'string',
				description:
					'Optional session returned by this same tool in the current launcher run.',
			},
		},
		required: ['prompt'],
		additionalProperties: false,
	};
	const tools = [
		{
			name: 'evidence',
			description:
				'Ask a read-only Codex helper to gather specific source evidence: caller maps, lifecycle traces or counterexamples. Return sources, coverage and uncertainty. Inspect deciding sources yourself. No edits or experiments.',
			inputSchema,
			annotations: { readOnlyHint: true },
		},
		...(mode === 'delegate'
			? [
					{
						name: 'implement',
						description:
							'Assign Codex a bounded implementation and checks in the assigned checkout. You own requirements, reasoning and acceptance; coordinating Codex has paused edits. This helper is the sole code writer. Preserve unrelated changes. Return changed paths, checks and unresolved issues; no commits, remote actions or child agents.',
						inputSchema,
						annotations: { readOnlyHint: false },
					},
				]
			: []),
	];

	return {
		tools,
		close() {
			stop?.();
		},
		async callTool(name: string, input: unknown, signal?: AbortSignal) {
			try {
				if (!tools.some((tool) => tool.name === name))
					throw new Error('Tool is not available for this assignment.');
				if (!input || typeof input !== 'object' || Array.isArray(input))
					throw new Error('Expected assignment arguments.');
				if (
					Object.keys(input).some(
						(key) => key !== 'prompt' && key !== 'session_id',
					)
				)
					throw new Error(
						'Only prompt and session_id may be supplied; access is fixed by the host.',
					);
				if (
					!('prompt' in input) ||
					typeof input.prompt !== 'string' ||
					!input.prompt.trim() ||
					input.prompt.length > 24_000
				)
					throw new Error(
						'Provide a nonempty prompt of at most 24000 characters.',
					);
				const sessionId = 'session_id' in input ? input.session_id : undefined;
				if (
					sessionId !== undefined &&
					(typeof sessionId !== 'string' || sessions.get(sessionId) !== name)
				)
					throw new Error(
						'Resume only a session returned by this same tool in the current launcher run.',
					);
				if (stop)
					throw new Error(
						'A Codex helper is already running. Wait for its result.',
					);
				if (calls >= maxCalls)
					throw new Error(
						'Codex call limit reached. Return the partial result to the coordinator.',
					);
				if (signal?.aborted) throw new Error('Request cancelled.');
				if (!authenticated) {
					const auth = spawnSync('codex', ['login', 'status'], {
						cwd,
						env,
						encoding: 'utf8',
						timeout: 30_000,
					});
					if (auth.error) throw auth.error;
					if (
						auth.status !== 0 ||
						!`${auth.stdout}${auth.stderr}`.includes('Logged in using ChatGPT')
					)
						throw new Error(
							'Codex must use its native ChatGPT login. No assignment was sent.',
						);
					authenticated = true;
				}
				// Config tables merge: an empty mcp_servers table does not clear them.
				// Discover names without connecting, then disable each explicitly. The
				// inert transport also keeps definitions valid when user config is skipped.
				const configured = spawnSync('codex', ['mcp', 'list', '--json'], {
					cwd,
					env,
					encoding: 'utf8',
					timeout: 30_000,
				});
				if (configured.error) throw configured.error;
				if (configured.status !== 0)
					throw new Error(
						'Could not enumerate Codex tool servers; no assignment was sent.',
					);
				const servers: unknown = JSON.parse(configured.stdout);
				if (!Array.isArray(servers))
					throw new Error('Invalid Codex tool-server inventory.');
				const disabledServers: string[] = [];
				for (const server of servers) {
					if (
						!server ||
						typeof server !== 'object' ||
						typeof server.name !== 'string' ||
						!/^[a-zA-Z0-9_-]+$/.test(server.name)
					)
						throw new Error(
							'Cannot safely disable a configured Codex tool server.',
						);
					const transport = server.transport?.type;
					if (transport !== 'stdio' && transport !== 'streamable_http')
						throw new Error(
							'Unsupported Codex tool-server transport; no assignment was sent.',
						);
					disabledServers.push(
						'-c',
						`mcp_servers.${server.name}.enabled=false`,
						'-c',
						`mcp_servers.${server.name}.${transport === 'stdio' ? 'command="false"' : 'url="https://disabled.invalid"'}`,
					);
				}
				// A custom filesystem table replaces inherited safeguards. Restate
				// protected paths explicitly, then reopen only host-selected skills.
				const scopedPermissions =
					name === 'implement' && skillWriteRoots.length
						? [
								'-c',
								'default_permissions="claude-skills"',
								'-c',
								`permissions.claude-skills={filesystem={":root"="read",":tmpdir"="write",":slash_tmp"="write",":workspace_roots"={"."="write",".git"="read",".agents"="read",".codex"="read",".aws"="read",${skillWriteRoots.map((root) => `${JSON.stringify(root)}="write"`).join(',')}}},network={enabled=false}}`,
							]
						: [
								'-c',
								`sandbox_mode="${name === 'implement' ? 'workspace-write' : 'read-only'}"`,
								'-c',
								'sandbox_workspace_write.network_access=false',
								'-c',
								'sandbox_workspace_write.writable_roots=[]',
							];
				const args = [
					'exec',
					...(sessionId ? ['resume'] : []),
					'--ignore-user-config',
					'--ignore-rules',
					'--json',
					'--model',
					model,
					'-c',
					'model_provider="openai"',
					'-c',
					'model_reasoning_effort="medium"',
					...scopedPermissions,
					'-c',
					'approval_policy="never"',
					...disabledServers,
					'-c',
					'web_search="disabled"',
					'--disable',
					'hooks',
					'--disable',
					'plugins',
					'--disable',
					'apps',
					'--disable',
					'multi_agent',
					...(sessionId ? [sessionId] : []),
					'-',
				];
				const brief = [
					'You are a leaf Codex helper for a Claude-owned assignment. Read applicable AGENTS.md. Do not invoke Claude, spawn agents, commit, alter remotes, publish, deploy or change access settings. Treat the assignment as bounded by the accepted parent outcome.',
					name === 'implement'
						? 'Implement and run relevant checks only in the assigned checkout. Preserve unrelated changes. Return changed paths, actual check results and unresolved issues. Claude owns delivery and inspection; the coordinating Codex has paused edits and owns continuity and focused acceptance.'
						: 'Gather evidence read-only. Do not edit, install dependencies or run mutating checks. Return source locations, short decisive excerpts, search coverage and unresolved uncertainty. Do not replace the parent investigation with your own design decision.',
					'Keep your final report under 800 words. State any incomplete check plainly.',
					input.prompt,
				].join('\n\n');
				calls++;
				const child = spawn('codex', args, {
					cwd,
					env,
					detached: process.platform !== 'win32',
					stdio: ['pipe', 'pipe', 'pipe'],
				});
				child.stdout.setEncoding('utf8');
				child.stderr.setEncoding('utf8');
				stop = () => {
					if (!child.pid) return;
					try {
						if (process.platform === 'win32') child.kill('SIGKILL');
						else process.kill(-child.pid, 'SIGKILL');
					} catch {
						/* The helper may have exited before cancellation arrived. */
					}
				};
				let timedOut = false;
				let oversized = false;
				let stdout = '';
				let stderr = '';
				const cancel = () => stop?.();
				const timer = setTimeout(() => {
					timedOut = true;
					cancel();
				}, timeoutMs);
				signal?.addEventListener('abort', cancel, { once: true });
				child.stdout.on('data', (chunk) => {
					stdout += chunk.toString();
					if (stdout.length > 4_000_000) {
						oversized = true;
						cancel();
					}
				});
				child.stderr.on('data', (chunk) => {
					stderr = (stderr + chunk.toString()).slice(-4000);
				});
				child.stdin.on('error', () => {});
				child.stdin.end(brief);
				let exitCode: number | null;
				try {
					exitCode = await new Promise<number | null>((resolve, reject) => {
						child.once('error', reject);
						child.once('close', resolve);
					});
				} finally {
					clearTimeout(timer);
					signal?.removeEventListener('abort', cancel);
					stop = undefined;
				}
				let helperSession: string | undefined;
				let answer = '';
				let usage: unknown;
				let completed = false;
				let failure: unknown;
				for (const line of stdout.trim().split('\n')) {
					if (!line.trim()) continue;
					let event: unknown;
					try {
						event = JSON.parse(line);
					} catch (error) {
						if (timedOut || oversized || signal?.aborted) break;
						throw error;
					}
					if (!event || typeof event !== 'object' || !('type' in event))
						throw new Error('Invalid Codex event.');
					if (
						event.type === 'thread.started' &&
						'thread_id' in event &&
						typeof event.thread_id === 'string'
					)
						helperSession = event.thread_id;
					if (
						event.type === 'item.completed' &&
						'item' in event &&
						event.item &&
						typeof event.item === 'object' &&
						'type' in event.item &&
						event.item.type === 'agent_message' &&
						'text' in event.item &&
						typeof event.item.text === 'string'
					)
						answer = event.item.text;
					if (event.type === 'turn.completed') {
						completed = true;
						usage = 'usage' in event ? event.usage : undefined;
					}
					if (event.type === 'turn.failed' || event.type === 'error')
						failure =
							'error' in event
								? event.error
								: 'message' in event
									? event.message
									: event;
				}
				if (helperSession) sessions.set(helperSession, name);
				const isError =
					timedOut ||
					oversized ||
					!!signal?.aborted ||
					exitCode !== 0 ||
					!completed ||
					!!failure ||
					!answer;
				return {
					isError,
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({
								session_id: helperSession,
								requested_model: model,
								cwd,
								exit_code: exitCode,
								completed,
								timed_out: timedOut,
								cancelled: !!signal?.aborted,
								oversized,
								result: answer.slice(0, 16_000),
								truncated: answer.length > 16_000,
								usage,
								...(isError
									? {
											error:
												failure ??
												(stderr || 'Codex did not return a completed answer.'),
										}
									: {}),
							}),
						},
					],
				};
			} catch (error) {
				return {
					isError: true,
					content: [
						{
							type: 'text' as const,
							text: error instanceof Error ? error.message : String(error),
						},
					],
				};
			}
		},
	};
}

if (import.meta.main) {
	const { values } = parseArgs({
		options: {
			source: { type: 'string' },
			cwd: { type: 'string' },
			mode: { type: 'string' },
			model: { type: 'string' },
			'max-calls': { type: 'string', default: '4' },
			'timeout-ms': { type: 'string', default: '300000' },
			'write-root': { type: 'string', multiple: true },
		},
	});
	if (
		!values.source ||
		!values.cwd ||
		!values.model ||
		(values.mode !== 'consult' && values.mode !== 'delegate')
	)
		throw new Error('Codex assistance requires source, cwd, mode and model.');
	const assistance = createCodexAssistance({
		source: values.source,
		cwd: values.cwd,
		mode: values.mode,
		model: values.model,
		maxCalls: Number(values['max-calls']),
		timeoutMs: Number(values['timeout-ms']),
		writeRoots: values['write-root'],
	});
	const server = new Server(
		{ name: 'codex-assistance', version: '1.0.0' },
		{ capabilities: { tools: {} } },
	);
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: assistance.tools,
	}));
	server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
		assistance.callTool(
			request.params.name,
			request.params.arguments,
			extra.signal,
		),
	);
	server.onclose = () => assistance.close();
	for (const signal of ['SIGINT', 'SIGTERM'] as const)
		process.once(signal, () => {
			assistance.close();
			process.exit(0);
		});
	await server.connect(new StdioServerTransport());
}
