/**
 * `local-mail mcp`: a stdio Model Context Protocol server that exposes read
 * and refresh verbs over the local Gmail mirror to a foreign host (Claude Code,
 * Codex, Cursor, ...).
 *
 * Why MCP, and why local stdio: Local Mail is a private Gmail mirror for local
 * tools. A subprocess reading the local SQLite directly is the exposure that
 * keeps mail data on the machine while still speaking the vocabulary foreign
 * hosts already understand. So "let an agent use Local Mail" reduces to this
 * file: it adds no mesh, no relay, no shared workspace state.
 *
 * The shape: each tool is one entry in `TOOLS` whose `input` is a TypeBox
 * schema. TypeBox IS JSON Schema at runtime, so the same object is the MCP
 * `inputSchema` (serialized over the wire) AND the validator (`Value.Check`,
 * in-process), with zero duplication. Each `run` maps straight onto an
 * existing Result-returning core.
 *
 * stdout is the JSON-RPC channel, so this subcommand prints NOTHING to stdout
 * except protocol frames: no banners, no `console.log`, no progress. The cores
 * are handed no `log` sink (their default is a no-op), so nothing leaks; a
 * single stray byte would corrupt framing.
 *
 * Error model (MCP's two channels):
 *  - unknown tool / invalid arguments -> `throw new McpError(...)`, a JSON-RPC
 *    protocol error (the call itself was malformed).
 *  - a tool that ran and failed (bad SQL, a missing token, a Gmail sync
 *    failure) -> a normal result with `isError: true` and a text message, so
 *    the model can read it and self-correct.
 *
 * No connected account is a startup failure (stderr, exit 1), not a per-call
 * error: the runtime freezes one account identity for the whole session.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
	CallToolRequestSchema,
	type CallToolResult,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { type Static, type TObject, Type } from 'typebox';
import { Value } from 'typebox/value';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { acquireSyncLock, syncOwnerBusy } from './lock.ts';
import { resolveAndModifyMessageLabels } from './modify.ts';
import { queryMail } from './query.ts';
import {
	type LocalMailRuntime,
	openLocalMailRuntime,
	openSyncSession,
} from './runtime.ts';
import { readMailStatus } from './status.ts';
import { syncMailbox } from './sync.ts';
import { VERSION } from './version.ts';

/**
 * WITHDRAWN MODEL in the two write tools below. `modify_labels` calls Gmail from
 * the tool handler and `sync` is a peer verb that only pulls. ADR-0199 replaced
 * that: a write tool records durable label assertions (ADR-0198) and returns,
 * one reconciler per account is the only Gmail writer, and a pass is
 * drain-then-pull, so `sync` becomes `reconcile`. The catalog collapses to
 * `query`, `status`, `reconcile`, `assert`, and `pending`, the last of which is
 * how an agent checks that work it queued actually landed instead of assuming a
 * returned outcome means Gmail agreed.
 *
 * The `description` strings below are left describing what the tools do today on
 * purpose: they are a runtime contract an MCP client reads, so they must stay
 * true to the running code rather than to the destination. See
 * `specs/20260801T210000-local-mail-intent-and-reconciler-clean-break.md`.
 *
 * A tool that ran to completion but failed can still carry its structured
 * outcome: `modify_labels` sets `structured` on a systemic abort so the model
 * reads the per-id results even while `isError` flags the abort. That shape goes
 * away with the direct write path.
 */
type ToolFailure = { message: string; structured?: unknown };
type ToolOutcome = Result<unknown, ToolFailure>;

type ToolDescriptor = {
	name: string;
	title: string;
	description: string;
	input: TObject;
	tier: 'read' | 'write' | 'mutation';
	run: (
		ctx: LocalMailRuntime,
		args: Record<string, unknown>,
	) => Promise<ToolOutcome>;
};

function defineMcpTool<S extends TObject>(tool: {
	name: string;
	title: string;
	description: string;
	input: S;
	tier: 'read' | 'write' | 'mutation';
	run: (ctx: LocalMailRuntime, args: Static<S>) => Promise<ToolOutcome>;
}): ToolDescriptor {
	return { ...tool, run: (ctx, args) => tool.run(ctx, args as Static<S>) };
}

const TOOLS: ToolDescriptor[] = [
	defineMcpTool({
		name: 'query',
		title: 'Query mail',
		description:
			'Run a read-only SQL query against the local Gmail mirror. Tables: messages(id, resource JSON, thread_id, snippet, label_ids JSON array, internal_date epoch millis, subject, sender, body_text, synced_at) and labels(id, resource JSON, name, type, synced_at). resource is the parsed messages.get(format=full) payload, not RFC 5322 MIME; attachment bytes are never stored. label_ids is JSON text: test membership with EXISTS (SELECT 1 FROM json_each(messages.label_ids) WHERE value = ?). Results are capped at 1000 rows. The schema can change between versions because the mirror is disposable, so saved queries are not a stable contract.',
		input: Type.Object({
			sql: Type.String({
				description:
					'A read-only SQL SELECT over messages or labels. Results are capped at 1000 rows.',
			}),
		}),
		tier: 'read',
		async run(ctx, args) {
			return queryMail({
				dataDir: ctx.config.dataDir,
				accountEmail: ctx.accountEmail,
				sql: args.sql,
			});
		},
	}),
	defineMcpTool({
		name: 'status',
		title: 'Mail status',
		description:
			'Report the connected account, cursor state, and local mirror row counts.',
		input: Type.Object({}),
		tier: 'read',
		async run(ctx) {
			return Ok(await readMailStatus(ctx));
		},
	}),
	defineMcpTool({
		name: 'sync',
		title: 'Refresh mail',
		description:
			'Refresh the local Gmail mirror. Incremental by default; pass full to force a complete re-pull. This only updates the local copy.',
		input: Type.Object({
			full: Type.Optional(
				Type.Boolean({
					description:
						'Force a full re-pull instead of incremental history sync.',
				}),
			),
		}),
		tier: 'write',
		async run(ctx, args) {
			// Sync needs a single owner per account. If the app (or another sync)
			// holds the lock, yield with a note instead of racing a second bulk
			// pull; nothing failed, so this is Ok, not an error. The model can just
			// read the mirror, which is being kept fresh by whoever owns the loop.
			const lock = acquireSyncLock({
				dataDir: ctx.config.dataDir,
				accountEmail: ctx.accountEmail,
			});
			if (!lock) {
				return Ok(syncOwnerBusy(ctx.accountEmail));
			}
			try {
				const { data: session, error } = await openSyncSession(ctx);
				if (error) return Err(error);
				try {
					const outcome = await syncMailbox(session.deps, {
						forceFull: args.full ?? false,
					});
					if (outcome.failure) {
						return Err({
							message: `Sync failed (${outcome.failure.name}: ${outcome.failure.message}). The cursor did not advance.`,
						});
					}
					return Ok(outcome);
				} finally {
					session.close();
				}
			} finally {
				lock.release();
			}
		},
	}),
	defineMcpTool({
		name: 'modify_labels',
		title: 'Modify message labels',
		description:
			'Add or remove Gmail labels on 1 to 100 messages. Pass Gmail label ids or exact label names; UNREAD marks unread, removing UNREAD marks read, removing INBOX archives, and adding INBOX unarchives. Gmail accepts or rejects each mutation before the local mirror is folded.',
		input: Type.Object({
			ids: Type.Array(Type.String({ minLength: 1 }), {
				minItems: 1,
				maxItems: 100,
				description: 'Gmail message ids to mutate serially.',
			}),
			addLabels: Type.Optional(
				Type.Array(Type.String({ minLength: 1 }), {
					maxItems: 100,
					description: 'Gmail label ids or exact names to add.',
				}),
			),
			removeLabels: Type.Optional(
				Type.Array(Type.String({ minLength: 1 }), {
					maxItems: 100,
					description: 'Gmail label ids or exact names to remove.',
				}),
			),
		}),
		tier: 'mutation',
		async run(ctx, args) {
			const { data: session, error } = await openSyncSession(ctx);
			if (error) return Err(error);
			try {
				const { data, error: modifyError } =
					await resolveAndModifyMessageLabels({
						deps: session.deps,
						ids: args.ids,
						addLabels: args.addLabels ?? [],
						removeLabels: args.removeLabels ?? [],
						readOnly: ctx.config.readOnly,
					});
				// A whole-request refusal (read-only, empty sets, unknown label)
				// never ran, so it is a plain error with no structured payload.
				if (modifyError) return Err({ message: modifyError.message });
				// A systemic abort (token, throttle, network) ran partway: flag
				// isError but keep the per-id results so the model sees what
				// succeeded. Per-id Gmail rejections are NOT an error channel;
				// they ride inside the structured results for per-id self-repair.
				if (data.aborted) {
					return Err({
						message: `Modify aborted after ${data.results.length} of ${args.ids.length} id(s): ${data.aborted.message}`,
						structured: data,
					});
				}
				return Ok(data);
			} finally {
				session.close();
			}
		},
	}),
];

function toCallResult({ data, error }: ToolOutcome): CallToolResult {
	if (error) {
		const result: CallToolResult = {
			content: [{ type: 'text', text: error.message }],
			isError: true,
		};
		if (error.structured !== undefined) {
			result.structuredContent = error.structured as Record<string, unknown>;
		}
		return result;
	}
	return {
		content: [{ type: 'text', text: JSON.stringify(data) }],
		structuredContent: data as Record<string, unknown>,
	};
}

export async function runMcpServer(): Promise<number> {
	// The account identity is frozen at server start (one runtime for the
	// whole session): connecting another account mid-session must not flip
	// which mailbox existing tools talk to. A host that wants a newly
	// connected account restarts the server. No account at all fails fast on
	// stderr rather than serving tools that can only error.
	const { data: runtime, error: runtimeError } = await openLocalMailRuntime();
	if (runtimeError) {
		console.error(runtimeError.message);
		return 1;
	}

	const server = new Server(
		{ name: 'local-mail', version: VERSION },
		{ capabilities: { tools: {} } },
	);
	const tools = TOOLS.filter(
		(tool) => tool.tier !== 'mutation' || !runtime.config.readOnly,
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: tools.map((tool) => ({
			name: tool.name,
			title: tool.title,
			description: tool.description,
			inputSchema: tool.input,
			annotations: {
				readOnlyHint: tool.tier === 'read',
				destructiveHint: false,
				...(tool.tier === 'mutation' ? { idempotentHint: true } : {}),
			},
		})),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		const tool = tools.find((candidate) => candidate.name === req.params.name);
		if (!tool) {
			throw new McpError(
				ErrorCode.MethodNotFound,
				`Unknown tool: ${req.params.name}`,
			);
		}
		const callArgs: Record<string, unknown> = req.params.arguments ?? {};
		if (!Value.Check(tool.input, callArgs)) {
			const detail = Value.Errors(tool.input, callArgs)
				.map((error) => `${error.instancePath || '/'}: ${error.message}`)
				.join('; ');
			throw new McpError(
				ErrorCode.InvalidParams,
				`Invalid arguments for "${tool.name}": ${detail}`,
			);
		}
		return toCallResult(await tool.run(runtime, callArgs));
	});

	const transport = new StdioServerTransport();
	const closed = new Promise<void>((resolve) => {
		server.onclose = () => resolve();
		process.stdin.once('end', resolve);
		process.stdin.once('close', resolve);
	});
	await server.connect(transport);
	await closed;
	return 0;
}
