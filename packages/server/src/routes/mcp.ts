/**
 * The folder MCP server (ADR-0550): MCP over streamable HTTP at the MCP
 * audience, `https://mcp.epicenter.so/mcp` for the hosted cloud and
 * `<origin>/mcp` for any other deployment (`resolveOAuthAudiences`).
 *
 * ```txt
 * POST <mcp audience>    JSON-RPC; one stateless server per request, JSON answers
 * GET, DELETE            405: there is no session and no server-sent stream
 * ```
 *
 * Every request carries an access token for the MCP audience. The request is
 * checked first with `authorizeAccountRequest`: a missing, unknown, or other
 * audience's token is 401 with `resource_metadata` (RFC 9728), so a client
 * discovers the authorization server; a call to `write_files` without
 * `folders:write`, or any request without `folders:read`, is 403
 * `insufficient_scope` naming the scopes to step up to. Then every tool that
 * names a repository is decided again by `authorizeResourceRequest` for that
 * namespace and name: the grant's target (`*` or `ns:<id>`), the account's
 * membership, and its role. A namespace the grant does not reach, or a role
 * that may not push, is the tool's error, not the request's.
 *
 * | Tool              | Scope           | Role | Answers |
 * | ----------------- | --------------- | ---- | ------- |
 * | `list_folders`    | `folders:read`  | read | the grant's repositories, "Personal" or by group title |
 * | `describe_folder` | `folders:read`  | read | `epicenter.json`, the head commit, and the file count |
 * | `list_files`      | `folders:read`  | read | paths under a prefix at a commit |
 * | `read_files`      | `folders:read`  | read | each path's content; an LFS file as its pointer |
 * | `write_files`     | `folders:write` | push | one commit on `base`, refused when `base` is not the head |
 * | `history`         | `folders:read`  | read | the commits that touch a path |
 *
 * The server reaches storage as itself, through the `GitHost` store
 * (`hosted-repository.ts`); a client's token never leaves this module. A
 * commit's author is the grant's account, named with the client that made it.
 */
import {
	isNamespaceId,
	isRepositoryName,
} from '@epicenter/constants/repositories';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
	CallToolRequestSchema,
	type CallToolResult,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
	type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { type } from 'arktype';
import { sql } from 'drizzle-orm';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { every } from 'hono/combine';
import { createMiddleware } from 'hono/factory';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import type { OAuthAudiences, OAuthScope } from '../auth/oauth-policy.js';
import {
	type AccountAccess,
	authorizeAccountRequest,
	authorizeResourceRequest,
	protectedResourceMetadataUrl,
	readAccessToken,
} from '../auth/resource-access.js';
import type { Db } from '../db/create-db.js';
import {
	type HostedRepository,
	openHostedRepository,
} from '../hosted-repository.js';
import { type NamespaceOperation, roleAllows } from '../namespace-roles.js';
import { listRepositories } from '../repositories.js';
import type { CloudEnv } from '../types.js';
import type { GitHost } from './git.js';

const log = createLogger('mcp');

/** Operator diagnostics. Their causes stay in the log, off the wire. */
const McpServerError = defineErrors({
	AuthorizeFailed: ({ cause }: { cause: unknown }) => ({
		message: `Could not decide an MCP request: ${extractErrorMessage(cause)}`,
		cause,
	}),
	StoreFailed: ({ tool, cause }: { tool: string; cause: unknown }) => ({
		message: `${tool} could not reach the repository: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

const Repository = {
	namespace: 'string',
	name: 'string',
} as const;
const Commit = 'string';

/** Each tool: its arguments, the scope and role operation it needs, and what it does. */
const TOOLS = {
	list_folders: {
		description:
			'List the folders (hosted repositories) this connection reaches, grouped as "Personal" or by group title. Each folder is named by its namespace and name.',
		input: type({}),
		scope: 'folders:read',
		operation: 'read',
	},
	describe_folder: {
		description:
			'Describe one folder: its declaration (epicenter.json as published), its head commit, and how many files it holds. Call this before reading or writing a folder you have not seen.',
		input: type(Repository),
		scope: 'folders:read',
		operation: 'read',
	},
	list_files: {
		description:
			'List the file paths in a folder under a prefix, at a commit (the head by default).',
		input: type({ ...Repository, 'prefix?': 'string', 'commit?': Commit }),
		scope: 'folders:read',
		operation: 'read',
	},
	read_files: {
		description:
			'Read files from a folder at a commit (the head by default). A large file kept in Git LFS answers its pointer and size, never its bytes; a binary file answers its size.',
		input: type({
			...Repository,
			paths: 'string[] <= 100',
			'commit?': Commit,
		}),
		scope: 'folders:read',
		operation: 'read',
	},
	write_files: {
		description:
			'Make one commit in a folder. `base` must be the head commit you read (null for an empty folder); when the folder has moved on, nothing is written and the answer names the current head, so read again and write again. Each change is `{ path, content }` to write a text file or `{ path, delete: true }` to remove one.',
		input: type({
			...Repository,
			base: 'string | null',
			message: 'string > 0',
			changes: type({ path: 'string', content: 'string' })
				.or({ path: 'string', delete: 'true' })
				.array()
				.atLeastLength(1)
				.atMostLength(100),
		}),
		scope: 'folders:write',
		operation: 'push',
	},
	history: {
		description:
			'List the commits that touch a path in a folder, newest first, from a commit (the head by default). Without a path, every commit.',
		input: type({
			...Repository,
			'path?': 'string',
			'commit?': Commit,
			'limit?': '1 <= number.integer <= 100',
		}),
		scope: 'folders:read',
		operation: 'read',
	},
} satisfies Record<
	string,
	{
		description: string;
		input: type.Any;
		scope: OAuthScope;
		operation: NamespaceOperation;
	}
>;
type ToolName = keyof typeof TOOLS;

function isToolName(name: string): name is ToolName {
	return Object.hasOwn(TOOLS, name);
}

/** The tools as `tools/list` answers them. */
const TOOL_LIST: Tool[] = (
	Object.entries(TOOLS) as [ToolName, (typeof TOOLS)[ToolName]][]
).map(([name, tool]) => ({
	name,
	description: tool.description,
	inputSchema: tool.input.toJsonSchema() as Tool['inputSchema'],
	annotations:
		tool.scope === 'folders:read'
			? { readOnlyHint: true, openWorldHint: false }
			: {
					readOnlyHint: false,
					destructiveHint: true,
					idempotentHint: false,
					openWorldHint: false,
				},
}));

/** The scope a JSON-RPC body needs: `folders:write` when it calls `write_files`. */
function scopeFor(body: unknown): OAuthScope {
	const messages = Array.isArray(body) ? body : [body];
	for (const message of messages) {
		const { method, params } = (message ?? {}) as {
			method?: unknown;
			params?: { name?: unknown };
		};
		if (method !== 'tools/call') continue;
		const name = params?.name;
		if (typeof name === 'string' && isToolName(name))
			if (TOOLS[name].scope === 'folders:write') return 'folders:write';
	}
	return 'folders:read';
}

function answer(value: object): CallToolResult {
	return {
		content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
		structuredContent: value as Record<string, unknown>,
	};
}

function refusal(message: string): CallToolResult {
	return { content: [{ type: 'text', text: message }], isError: true };
}

type ToolContext = {
	db: Db;
	token: string;
	account: AccountAccess;
	audiences: OAuthAudiences;
	host: GitHost;
	signal: AbortSignal;
};

/**
 * The repository a tool names, decided for this token, then opened; or the
 * refusal the tool answers.
 */
async function reach(
	context: ToolContext,
	tool: ToolName,
	{ namespace, name }: { namespace: string; name: string },
): Promise<
	| {
			namespace: string;
			name: string;
			repository: HostedRepository;
			accountId: string;
			clientId: string;
	  }
	| { refused: string }
> {
	if (!isNamespaceId(namespace) || !isRepositoryName(name))
		return { refused: `No folder is named ${namespace}/${name}.` };
	const { scope, operation } = TOOLS[tool];
	const decided = await authorizeResourceRequest(context.db, {
		token: context.token,
		audience: context.audiences.mcp,
		scope,
		namespaceId: namespace,
		repository: name,
	});
	if (decided.error !== null)
		return { refused: decided.error.body.error_description };
	const access = decided.data;
	if (!roleAllows(access.role, operation))
		return {
			refused: `This account's role may not ${operation === 'push' ? 'write to' : 'read'} that namespace.`,
		};
	if (access.repository === null)
		return { refused: `No folder is named ${namespace}/${name}.` };
	const repository = await openHostedRepository(context.host, {
		repositoryId: access.repository.id,
		accountId: access.accountId,
		signal: context.signal,
	});
	return {
		namespace: access.namespaceId,
		name: access.repository.name,
		repository,
		accountId: access.accountId,
		clientId: access.clientId,
	};
}

/** The commit author for a write: the grant's account, named with its client. */
async function authorOf(db: Db, accountId: string, clientId: string) {
	const { rows } = await db.execute<{
		name: string | null;
		email: string;
		client_name: string | null;
	}>(sql`
		select u.name, u.email, c.name as client_name
		from "user" u
		left join oauth_client c on c.client_id = ${clientId}
		where u.id = ${accountId}
	`);
	const row = rows[0];
	if (row === undefined) throw new Error(`account ${accountId} has no row`);
	return {
		name: `${row.name || row.email} via ${row.client_name || clientId}`,
		email: row.email,
	};
}

async function callTool(
	context: ToolContext,
	tool: ToolName,
	args: unknown,
): Promise<CallToolResult> {
	const input = TOOLS[tool].input(args ?? {});
	if (input instanceof type.errors)
		throw new McpError(ErrorCode.InvalidParams, input.summary);

	if (tool === 'list_folders') {
		const namespaces = await listRepositories(context.db, {
			accountId: context.account.accountId,
			target: context.account.target,
			gitAudience: context.audiences.git,
		});
		return answer({
			groups: namespaces.map((namespace) => ({
				title: namespace.personal ? 'Personal' : namespace.title,
				namespace: namespace.id,
				role: namespace.role,
				folders: namespace.repositories.map(({ name, url }) => ({
					namespace: namespace.id,
					name,
					url,
				})),
			})),
		});
	}

	const named = input as { namespace: string; name: string };
	let reached: Awaited<ReturnType<typeof reach>>;
	try {
		reached = await reach(context, tool, named);
	} catch (cause) {
		log.error(McpServerError.StoreFailed({ tool, cause }).error);
		return refusal('The folder could not be reached. Try again.');
	}
	if ('refused' in reached) return refusal(reached.refused);
	const { repository } = reached;
	const folder = { namespace: reached.namespace, name: reached.name };

	try {
		switch (tool) {
			case 'describe_folder': {
				const files = await repository.listFiles();
				const [declaration] = await repository.readFiles(['epicenter.json']);
				let parsed: unknown = null;
				if (declaration !== undefined && 'content' in declaration)
					try {
						parsed = JSON.parse(declaration.content);
					} catch {
						parsed = declaration.content;
					}
				return answer({
					...folder,
					commit: repository.head,
					branch: repository.branch.replace(/^refs\/heads\//, ''),
					fileCount: files.length,
					declaration: parsed,
				});
			}
			case 'list_files': {
				const { prefix, commit } = input as {
					prefix?: string;
					commit?: string;
				};
				return answer({
					...folder,
					commit: commit ?? repository.head,
					paths: await repository.listFiles(prefix, commit),
				});
			}
			case 'read_files': {
				const { paths, commit } = input as {
					paths: string[];
					commit?: string;
				};
				return answer({
					...folder,
					commit: commit ?? repository.head,
					files: await repository.readFiles(paths, commit),
				});
			}
			case 'history': {
				const { path, commit, limit } = input as {
					path?: string;
					commit?: string;
					limit?: number;
				};
				return answer({
					...folder,
					commit: commit ?? repository.head,
					commits: await repository.history({
						path,
						commit,
						limit: limit ?? 20,
					}),
				});
			}
			case 'write_files': {
				const { base, message, changes } = input as {
					base: string | null;
					message: string;
					changes: (
						| { path: string; content: string }
						| { path: string; delete: true }
					)[];
				};
				const written = await repository.commit({
					base,
					message,
					changes,
					author: await authorOf(
						context.db,
						reached.accountId,
						reached.clientId,
					),
				});
				if (written.error !== null) return refusal(written.error.message);
				return answer({ ...folder, commit: written.data.commit });
			}
		}
	} catch (cause) {
		log.error(McpServerError.StoreFailed({ tool, cause }).error);
		return refusal('The folder could not be read or written. Try again.');
	}
}

/** One stateless MCP server for one request. */
function createFolderServer(context: ToolContext): Server {
	const server = new Server(
		{ name: 'epicenter-folders', version: '0.1.0' },
		{
			capabilities: { tools: {} },
			instructions:
				'Epicenter folders are Git repositories of Markdown tables, kv.json, and ordinary files. Start with list_folders, then describe_folder. write_files commits on the head you read and merges nothing.',
			// This server never asks the client for input, so it validates no
			// elicitation; Ajv's compiler cannot run on Workers.
			jsonSchemaValidator: {
				getValidator: () => () => ({
					valid: false,
					data: undefined,
					errorMessage: 'This server validates no client schemas.',
				}),
			},
		},
	);
	server.setRequestHandler(ListToolsRequestSchema, () => ({
		tools: TOOL_LIST,
	}));
	server.setRequestHandler(CallToolRequestSchema, ({ params }) => {
		if (!isToolName(params.name))
			throw new McpError(
				ErrorCode.InvalidParams,
				`There is no tool named ${params.name}.`,
			);
		return callTool(context, params.name, params.arguments);
	});
	return server;
}

/** Whether `url` is the MCP endpoint itself: the audience's origin and path. */
function isMcpEndpoint(url: URL, audience: string): boolean {
	const endpoint = new URL(audience);
	return (
		url.origin === endpoint.origin &&
		url.pathname.replace(/\/+$/, '') === endpoint.pathname.replace(/\/+$/, '')
	);
}

function refuse(
	c: Context<CloudEnv>,
	status: 400 | 401 | 403 | 405 | 503,
	error: string,
	description: string,
	challenge?: string,
) {
	const response = c.json({ error, error_description: description }, status);
	if (challenge !== undefined)
		response.headers.set('www-authenticate', challenge);
	return response;
}

/**
 * Mount the folder MCP server at the deployment's MCP audience. `setup`
 * installs the database (`c.var.db`), which every POST reads.
 */
export function mountMcpServer(
	app: Hono<CloudEnv>,
	{
		setup,
		resolveAudiences,
		resolveHost,
	}: {
		setup: MiddlewareHandler<CloudEnv>;
		resolveAudiences: (c: Context<CloudEnv>) => OAuthAudiences;
		/** `null` answers 503 `mcp_unavailable`: the server has no folders to reach. */
		resolveHost: (env: CloudEnv['Bindings']) => GitHost | null;
	},
): void {
	const serve = createMiddleware<CloudEnv>(async (c) => {
		const audiences = resolveAudiences(c);
		const host = resolveHost(c.env);
		if (host === null)
			return refuse(
				c,
				503,
				'mcp_unavailable',
				'This server does not host folders.',
			);
		// Read a copy: a body that is not JSON goes to the transport untouched,
		// which answers the JSON-RPC parse error.
		let body: unknown;
		try {
			body = await c.req.raw.clone().json();
		} catch {
			body = undefined;
		}
		const scope = scopeFor(body);
		const token = readAccessToken(c.req.header('authorization'));
		let decided: Awaited<ReturnType<typeof authorizeAccountRequest>>;
		try {
			decided = await authorizeAccountRequest(c.var.db, {
				token,
				audience: audiences.mcp,
				scope,
			});
		} catch (cause) {
			log.error(McpServerError.AuthorizeFailed({ cause }).error);
			return refuse(
				c,
				503,
				'mcp_unavailable',
				'The request could not be checked. Try again.',
			);
		}
		if (decided.error !== null) {
			const { status, body: refused } = decided.error;
			// A client steps up to both scopes, so the new token still reads.
			const challenge =
				refused.error === 'insufficient_scope'
					? `Bearer error="insufficient_scope", scope="${scope === 'folders:write' ? 'folders:read folders:write' : 'folders:read'}", resource_metadata="${protectedResourceMetadataUrl(audiences.mcp)}"`
					: decided.error.challenge;
			return refuse(
				c,
				status,
				refused.error,
				refused.error_description,
				challenge,
			);
		}
		const server = createFolderServer({
			db: c.var.db,
			token: token ?? '',
			account: decided.data,
			audiences,
			host,
			signal: c.req.raw.signal,
		});
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true,
		});
		await server.connect(transport);
		try {
			return await transport.handleRequest(
				c.req.raw,
				body === undefined ? undefined : { parsedBody: body },
			);
		} finally {
			await server.close();
		}
	});
	const handleMcp = every(setup, serve);
	app.use('*', async (c, next) => {
		if (!isMcpEndpoint(new URL(c.req.url), resolveAudiences(c).mcp))
			return next();
		if (c.req.method !== 'POST') {
			const response = refuse(
				c,
				405,
				'method_not_allowed',
				'This MCP server answers POST only: it keeps no session and opens no stream.',
			);
			response.headers.set('allow', 'POST');
			return response;
		}
		return handleMcp(c, next);
	});
}
