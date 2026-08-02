/**
 * `local-mail mcp`: a stdio Model Context Protocol server that exposes the local
 * Gmail mirror, and the triage vocabulary over it, to a foreign host (Claude
 * Code, Codex, Cursor, ...).
 *
 * An agent here plays by the same rules a human does. `assert_labels` records a
 * durable local change and returns; `reconcile` is the pass that talks to Gmail,
 * and it refuses to run when another owner already holds the account. Reads see
 * recorded-but-undelivered changes, so an agent and the open app never describe
 * the same mailbox differently.
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
import { assertMessageLabels } from './assert.ts';
import { acquireReconcileLock, reconcileOwnerBusy } from './lock.ts';
import { queryMail } from './query.ts';
import { reconcileAccount } from './reconcile.ts';
import {
	type LocalMailRuntime,
	openAccountSession,
	openLocalMailRuntime,
} from './runtime.ts';
import { readMailStatus } from './status.ts';
import { VERSION } from './version.ts';

/**
 * A tool that ran to completion but failed can still carry its structured
 * outcome: `modify_labels` sets `structured` on a systemic abort so the model
 * reads the per-id results even while `isError` flags the abort.
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
			"Run a read-only SQL query against the local Gmail mirror. Tables: messages(id, raw JSON, thread_id, snippet, label_ids JSON array, internal_date epoch millis, subject, sender, body_text, synced_at) and labels(id, raw JSON, name, type, synced_at). messages.label_ids is Gmail's LAST KNOWN label set. For what the app actually shows, which includes triage recorded locally and not yet delivered to Gmail, join the effective_labels(message_id, label_id) view instead: SELECT m.subject FROM messages m JOIN effective_labels e ON e.message_id = m.id WHERE e.label_id = 'INBOX'. Results are capped at 1000 rows. The schema can change between versions because the mirror is disposable, so saved queries are not a stable contract.",
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
		name: 'reconcile',
		title: 'Reconcile mail',
		description:
			'Deliver any locally recorded label changes to Gmail, then refresh the local mirror. Incremental by default; pass full to force a complete re-pull.',
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
			// A reconcile needs a single owner per account: it is the only writer to
			// Gmail. If the app (or another pass) holds the lock, yield with a note
			// instead of becoming a second one; nothing failed, so this is Ok, not
			// an error. That owner delivers the pending changes anyway.
			const lock = acquireReconcileLock({
				dataDir: ctx.config.dataDir,
				accountEmail: ctx.accountEmail,
			});
			if (!lock) {
				return Ok(reconcileOwnerBusy(ctx.accountEmail));
			}
			try {
				const { data: session, error } = await openAccountSession(ctx);
				if (error) return Err(error);
				try {
					const outcome = await reconcileAccount(session.deps, {
						forceFull: args.full ?? false,
						readOnly: ctx.config.readOnly,
					});
					// A failure in either phase is reportable, but the outcome rides
					// along: the model should see what DID get delivered, and that
					// nothing was lost.
					const failure = outcome.delivery.failure ?? outcome.pull.failure;
					if (failure) {
						return Err({
							message: `Reconcile incomplete (${failure.name}: ${failure.message}). Nothing was lost; undelivered changes are kept and the next pass retries.`,
							structured: outcome,
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
		name: 'assert_labels',
		title: 'Change message labels',
		description:
			'Record a label change for 1 to 500 messages: add or remove Gmail labels by id or exact name. UNREAD marks unread, removing UNREAD marks read, removing INBOX archives, adding INBOX unarchives, and adding TRASH moves to trash. The change is durable and visible to every local read immediately, including this mirror; Gmail is told by the next reconcile pass, which the open app runs on its own. Each message and label pair keeps only its latest requested state, so asking again replaces the previous answer rather than queueing a second change. One call cannot both add and remove the same label.',
		input: Type.Object({
			ids: Type.Array(Type.String({ minLength: 1 }), {
				minItems: 1,
				maxItems: 500,
				description: 'The Gmail message ids to change.',
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
			const { data: session, error } = await openAccountSession(ctx);
			if (error) return Err(error);
			try {
				const { data, error: assertError } = assertMessageLabels({
					deps: session.deps,
					input: {
						ids: args.ids,
						addLabels: args.addLabels ?? [],
						removeLabels: args.removeLabels ?? [],
					},
					readOnly: ctx.config.readOnly,
				});
				// The only failures are refusals that recorded nothing (read-only,
				// an empty label set, an unknown label name). Once recorded, an act
				// cannot fail: delivery is the reconciler's pass, not this call.
				if (assertError) return Err({ message: assertError.message });
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
