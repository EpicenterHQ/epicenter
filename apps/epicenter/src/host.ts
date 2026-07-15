/**
 * The Query host: one local desktop chat session; built-in apps enter
 * through one verb catalog (ADR-0080). Built-in apps open in-process and expose
 * action registries (arm A); boxed apps an upstream forces off the mesh may
 * join as local stdio MCP subprocesses (arm B, Local Books today). One agent
 * loop consumes the composed catalog and never learns where a verb lives.
 *
 * Each in-process app owns its Bun storage composition. Sign-in is still an
 * enhancement; the host opens disk-backed local workspaces without constructing
 * an auth client.
 *
 * Transcripts are durable the same way: the host's own workspace holds the
 * canonical conversations table (ADR-0055), locally connected, so finished
 * messages survive restarts on this machine without touching a relay. Boot
 * resumes the most recent conversation row; `clear` starts a fresh one. Sync
 * is a deliberate later wave that arrives with host sign-in.
 */

import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import {
	type Conversation,
	generateConversationId,
} from '@epicenter/chat/legacy';
import { honeycrispWorkspace } from '@epicenter/honeycrisp/legacy';
import { openTodosBun } from '@epicenter/todos/bun';
import { generateId, InstantString } from '@epicenter/workspace';
import {
	type AgentEngine,
	type AgentToolCall,
	type AgentToolDefinition,
	type Approval,
	type ConversationOptions,
	type ConversationSnapshot,
	composeToolCatalogs,
	createConversation,
	createLocalToolCatalog,
	defaultApprovalDecision,
	namespaceToolCatalog,
	resolveApprovedToolCall,
	type ToolCatalog,
} from '@epicenter/workspace/agent';
import { bunLocalPersistence } from '@epicenter/workspace/node';
import {
	createLocalSourceCatalog,
	type LocalSourceCatalogOptions,
} from './local-source-catalog.ts';
import {
	createStdioMcpCatalog,
	type StdioMcpCatalogOptions,
} from './stdio-mcp-catalog.ts';
import { queryWorkspace } from './workspace.ts';

export type QueryHostOptions = {
	/** The inference backend driving the loop (BYOK, local, or scripted). */
	engine: AgentEngine;
	/**
	 * The model id the engine serves, recorded on the conversation row
	 * (ADR-0055: a surface with one fixed model writes it and never reads it).
	 */
	model: string;
	/**
	 * Override the host-owned approval prompt. Tests use this for headless
	 * auto-approval; the shell omits it so pending mutations surface in-session.
	 */
	approval?: Approval;
	/**
	 * Spawn command for the Local Books stdio MCP server (arm B). Omitted means
	 * the host runs with the built-in apps only.
	 */
	localBooks?: StdioMcpCatalogOptions;
	/**
	 * A read-only local source to compose as one `query` verb (ADR-0115 wave 6),
	 * namespaced `imessage__`. Omitted means the host runs without a local source.
	 * The reader is injected (a fixture in tests, a real Messages reader later),
	 * so the source stays host-owned and never becomes reachable over the relay.
	 */
	localSource?: LocalSourceCatalogOptions;
	/** Host-owned data directory for built-in app replicas. */
	dataDir?: string;
};

export type PendingApproval = {
	id: string;
	toolCallId: string;
	toolName: string;
	title?: string;
	description?: string;
	input: AgentToolCall['input'];
	requestedAt: number;
};

export type QuerySessionSnapshot = {
	conversation: ConversationSnapshot;
	pendingApprovals: PendingApproval[];
	invocations: QueryInvocation[];
};

/**
 * One direct tool invocation, from command to settled outcome. This is a
 * record with a lifecycle, not an event: the host mutates `status` in place
 * and pushes a fresh snapshot. Direct invocations never touch the
 * conversation transcript; the model must not see operator-plane runs as
 * chat history.
 */
export type QueryInvocation = {
	id: string;
	toolName: string;
	status: 'running' | 'succeeded' | 'failed';
	/** The outcome's model-facing text once settled; the error text on failure. */
	content?: string;
	requestedAt: number;
	settledAt?: number;
};

/** What a session client may ask of the one host-owned session. */
export type QueryClientCommand =
	| { type: 'send'; content: string }
	| { type: 'stop' }
	| { type: 'retry' }
	| {
			/**
			 * Start a fresh session: abort any live turn and switch to a new
			 * conversation whose row is minted on its first send. The old
			 * transcript stays durable in its row; reopening one is a later wave
			 * (there is no conversation list yet).
			 */
			type: 'clear';
	  }
	| {
			type: 'approve';
			requestId: string;
			approved: boolean;
			alwaysAllowSession?: boolean;
	  }
	| {
			/**
			 * Run one catalog tool directly, outside a chat turn. The call rides the
			 * same approval gate as chat (`resolveApprovedToolCall`), so a direct
			 * mutation raises the same pending approval prompt; it can never bypass
			 * mutation policy (ADR-0113).
			 */
			type: 'invoke';
			toolName: string;
			input: AgentToolCall['input'];
	  };

/**
 * Validate one already-parsed frame against the command vocabulary. The host
 * owns what a valid command is (ADR-0113); transports own only the framing
 * that produced the value.
 */
export function parseQueryCommand(
	value: unknown,
): QueryClientCommand | undefined {
	if (value === null || typeof value !== 'object') return undefined;
	const command = value as Record<string, unknown>;
	if (command.type === 'send' && typeof command.content === 'string') {
		return { type: 'send', content: command.content };
	}
	if (command.type === 'stop') return { type: 'stop' };
	if (command.type === 'retry') return { type: 'retry' };
	if (command.type === 'clear') return { type: 'clear' };
	if (
		command.type === 'approve' &&
		typeof command.requestId === 'string' &&
		typeof command.approved === 'boolean'
	) {
		return {
			type: 'approve',
			requestId: command.requestId,
			approved: command.approved,
			...(command.alwaysAllowSession === true && {
				alwaysAllowSession: true,
			}),
		};
	}
	if (
		command.type === 'invoke' &&
		typeof command.toolName === 'string' &&
		command.toolName !== '' &&
		typeof command.input === 'object' &&
		command.input !== null &&
		!Array.isArray(command.input)
	) {
		return {
			type: 'invoke',
			toolName: command.toolName,
			// Every tool input schema in the catalog is a JSON object, so the
			// vocabulary accepts only plain objects. Frames arrive from JSON.parse,
			// which makes a plain object here JSON by construction.
			input: command.input as AgentToolCall['input'],
		};
	}
	return undefined;
}

export type QueryHost = {
	/** The model-visible tool surface, for shells that list or introspect tools. */
	toolDefinitions(): AgentToolDefinition[];
	/** Read the render state owned by the host session. */
	snapshot(): QuerySessionSnapshot;
	/** Register for any conversation or approval-state change. */
	subscribe(listener: () => void): () => void;
	/** Apply one client command to the host-owned session. */
	handleCommand(command: QueryClientCommand): boolean;
	[Symbol.asyncDispose](): Promise<void>;
};

const INVOCATION_LIMIT = 20;

/**
 * Open the built-in apps, compose their catalogs, and start the one chat
 * session over them.
 */
export async function createQueryHost(
	options: QueryHostOptions,
): Promise<QueryHost> {
	// Arm A: in-process apps. Each namespace keeps same-named verbs distinct in
	// the composed surface; the prefix must not contain `__`.
	const dataDir = options.dataDir ?? defaultDataDir();
	const apps = await openBuiltInApps(dataDir);
	const { honeycrisp, todos, query } = apps;
	const catalogs: ToolCatalog[] = [
		namespaceToolCatalog(
			'honeycrisp',
			createLocalToolCatalog(honeycrisp.actions),
		),
		namespaceToolCatalog('todos', createLocalToolCatalog(todos.actions)),
	];

	// A read-only local source, if one is wired: one `query` verb the host reads
	// on this machine (ADR-0115 wave 6). Stateless, so it needs no disposal and
	// no `whenLoaded`; it composes beside the in-process apps behind the one seam.
	if (options.localSource) {
		catalogs.push(
			namespaceToolCatalog(
				'imessage',
				createLocalSourceCatalog(options.localSource),
			),
		);
	}

	// Arm B: boxed apps join as stdio MCP subprocesses behind the same seam.
	const localBooks = options.localBooks
		? await createStdioMcpCatalog(options.localBooks).catch(async (error) => {
				await apps[Symbol.asyncDispose]();
				throw error;
			})
		: undefined;
	if (localBooks) {
		catalogs.push(namespaceToolCatalog('localbooks', localBooks));
	}

	const tools = composeToolCatalogs(catalogs);
	const listeners = new Set<() => void>();
	const notify = () => {
		for (const listener of listeners) listener();
	};
	const sessionApproval = createSessionApproval(notify);
	// One approval policy for the whole session: chat turns and direct
	// invocations must share it so mutation policy cannot drift by caller.
	const approval = options.approval ?? sessionApproval.approval;

	// Resume the most recent session; a host with no history starts a fresh id
	// whose row is minted lazily on the first successful send, so an idle
	// launch leaves no empty row behind.
	const conversations = query.tables.conversations;
	let latest: Conversation | undefined;
	for (const row of conversations.scan().rows) {
		if (latest === undefined || row.updatedAt > latest.updatedAt) latest = row;
	}
	let activeConversationId = latest?.id ?? generateConversationId();

	const buildConversation = (store: ConversationOptions['store']) =>
		createConversation({
			store,
			engine: options.engine,
			tools,
			approval,
			generateId,
		});

	// The row's messages child doc is the loop's message store (ADR-0055):
	// finished messages land there and survive restarts. Loaded before the
	// loop starts so a first send never races the replayed history.
	let activeStore = conversations.docs.messages.open(activeConversationId);
	await activeStore.whenLoaded;
	let conversation = buildConversation(activeStore);
	// One relay subscription that survives `clear` swapping the conversation;
	// host listeners subscribe to the host, never to a conversation instance.
	let unbindConversation = conversation.subscribe(notify);
	// Child-doc flushes are not covered by `storage.whenDisposed`; stores
	// swapped out by `clear` park their flush promise here for disposal.
	const storeFlushes: Promise<unknown>[] = [];

	/**
	 * Keep the active row honest after a started turn: mint it on the session's
	 * first send, name it from the first user message (app-shell convention:
	 * 'New Chat' until the first user message's first 50 chars), bump recency.
	 */
	const touchConversationRow = (content: string) => {
		const now = InstantString.now();
		const { data: existing } = conversations.get(activeConversationId);
		if (!existing) {
			conversations.set({
				id: activeConversationId,
				title: content.slice(0, 50),
				model: options.model,
				createdAt: now,
				updatedAt: now,
			});
			return;
		}
		// The write Result is deliberately dropped (app-shell does the same): the
		// only failure is a row this binary cannot read (newer schema), and there
		// is no fallback write that would not clobber it.
		conversations.update(activeConversationId, {
			title:
				existing.title === 'New Chat' ? content.slice(0, 50) : existing.title,
			model: options.model,
			updatedAt: now,
		});
	};

	// Direct invocations outlive no one: this controller aborts any still-running
	// invoke when the host disposes, before the catalogs go away. Settlement
	// after the abort rides the catalog honoring the signal, the same contract
	// chat turns rely on; disposal never awaits invocations.
	const invokeAbort = new AbortController();
	const invocations: QueryInvocation[] = [];
	const runInvocation = (toolName: string, input: AgentToolCall['input']) => {
		const invocation: QueryInvocation = {
			id: generateId(),
			toolName,
			status: 'running',
			requestedAt: Date.now(),
		};
		invocations.push(invocation);
		// The cap bounds settled history only, and trims on push alone: a running
		// record must stay visible until it settles, and a settling record must
		// be observable at least once, so nothing evicts on settle. A concurrent
		// burst may briefly exceed the cap; later pushes converge it.
		while (invocations.length > INVOCATION_LIMIT) {
			const evictable = invocations.findIndex(
				(candidate) => candidate.status !== 'running',
			);
			if (evictable === -1) break;
			invocations.splice(evictable, 1);
		}
		notify();
		void resolveApprovedToolCall({
			tools,
			approval,
			call: { toolCallId: invocation.id, toolName, input },
			signal: invokeAbort.signal,
		})
			// Catalogs report failures as outcomes, but an abort mid-resolve (host
			// disposal) can reject; the record must still settle.
			.catch((error) => ({
				content: error instanceof Error ? error.message : String(error),
				isError: true,
			}))
			.then((outcome) => {
				invocation.status = outcome.isError ? 'failed' : 'succeeded';
				invocation.content = outcome.content;
				invocation.settledAt = Date.now();
				notify();
			});
	};

	return {
		toolDefinitions() {
			return tools.definitions();
		},
		snapshot() {
			return {
				conversation: conversation.snapshot(),
				pendingApprovals: sessionApproval.pending(),
				invocations: invocations.map((invocation) => ({ ...invocation })),
			};
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		handleCommand(command) {
			switch (command.type) {
				case 'send': {
					const started = conversation.send(command.content);
					if (started) touchConversationRow(command.content);
					return started;
				}
				case 'stop':
					conversation.stop();
					sessionApproval.cancelAll();
					return true;
				case 'retry':
					conversation.retry();
					return true;
				case 'clear': {
					// Abort any live turn first (as `stop` and disposal do), then
					// resolve its approvals denied and swap to a fresh conversation.
					// The old transcript stays durable in its row.
					unbindConversation();
					storeFlushes.push(activeStore.whenDisposed);
					conversation[Symbol.dispose]();
					sessionApproval.cancelAll();
					activeConversationId = generateConversationId();
					activeStore = conversations.docs.messages.open(activeConversationId);
					conversation = buildConversation(activeStore);
					unbindConversation = conversation.subscribe(notify);
					notify();
					return true;
				}
				case 'approve':
					return sessionApproval.answer({
						requestId: command.requestId,
						approved: command.approved,
						alwaysAllowSession: command.alwaysAllowSession === true,
					});
				case 'invoke':
					runInvocation(command.toolName, command.input);
					return true;
				default:
					command satisfies never;
					return false;
			}
		},
		async [Symbol.asyncDispose]() {
			// The conversation first (aborts any in-flight turn and disposes the
			// store), then the subprocess, then the in-process docs.
			conversation[Symbol.dispose]();
			invokeAbort.abort();
			sessionApproval.cancelAll();
			await localBooks?.[Symbol.asyncDispose]();
			await Promise.all([
				apps[Symbol.asyncDispose](),
				// Transcript flushes: the active store plus any `clear` left behind.
				activeStore.whenDisposed,
				...storeFlushes,
			]);
		},
	};
}

/** Open and jointly own the host's three in-process application runtimes. */
async function openBuiltInApps(dataDir: string) {
	await using stack = new AsyncDisposableStack();
	const persistence = bunLocalPersistence({ dir: dataDir });
	const honeycrisp = honeycrispWorkspace.connect(
		{ kind: 'local' },
		{ persistence },
	);
	stack.defer(async () => {
		honeycrisp[Symbol.dispose]();
		await honeycrisp.storage.whenDisposed;
	});
	// The host's own workspace: durable transcripts, same ungated local preset.
	const query = queryWorkspace.connect({ kind: 'local' }, { persistence });
	stack.defer(async () => {
		query[Symbol.dispose]();
		await query.storage.whenDisposed;
	});
	await Promise.all([honeycrisp.storage.whenLoaded, query.storage.whenLoaded]);
	const todos = await openTodosBun({
		path: join(dataDir, 'epicenter-todos-v1.sqlite'),
	});
	stack.defer(() => todos[Symbol.asyncDispose]());
	const teardown = stack.move();
	return {
		honeycrisp,
		todos,
		query,
		[Symbol.asyncDispose]: () => teardown.disposeAsync(),
	};
}

/**
 * The session's one approval gate: pending prompts and session-scoped grants,
 * host-local and non-durable by design (an unanswered prompt dies with the
 * process). `notify` fires on every pending-set change so attached clients
 * re-render prompts from host state, not from the socket that first saw them.
 */
function createSessionApproval(notify: () => void) {
	const pending = new Map<
		string,
		{
			prompt: PendingApproval;
			resolve(approved: boolean): void;
		}
	>();
	const sessionGrants = new Set<string>();

	const approval: Approval = {
		decide(call, definition) {
			if (sessionGrants.has(call.toolName)) return 'auto';
			return defaultApprovalDecision(call, definition);
		},
		request(call, definition) {
			const id = generateId();
			const prompt: PendingApproval = {
				id,
				toolCallId: call.toolCallId,
				toolName: call.toolName,
				...(definition.title !== undefined && { title: definition.title }),
				...(definition.description !== undefined && {
					description: definition.description,
				}),
				input: call.input,
				requestedAt: Date.now(),
			};
			return new Promise<boolean>((resolve) => {
				pending.set(id, { prompt, resolve });
				notify();
			});
		},
	};

	return {
		approval,
		pending() {
			return [...pending.values()].map(({ prompt }) => prompt);
		},
		answer({
			requestId,
			approved,
			alwaysAllowSession,
		}: {
			requestId: string;
			approved: boolean;
			alwaysAllowSession: boolean;
		}) {
			const entry = pending.get(requestId);
			if (!entry) return false;
			pending.delete(requestId);
			if (approved && alwaysAllowSession) {
				sessionGrants.add(entry.prompt.toolName);
			}
			entry.resolve(approved);
			notify();
			return true;
		},
		cancelAll() {
			if (pending.size === 0) return;
			const entries = [...pending.values()];
			pending.clear();
			for (const entry of entries) entry.resolve(false);
			notify();
		},
	};
}

function defaultDataDir(): string {
	if (process.env.EPICENTER_QUERY_DATA_DIR)
		return process.env.EPICENTER_QUERY_DATA_DIR;
	if (platform() === 'darwin') {
		return join(homedir(), 'Library', 'Application Support', 'epicenter-query');
	}
	const xdgDataHome = process.env.XDG_DATA_HOME;
	if (xdgDataHome) return join(xdgDataHome, 'epicenter-query');
	return join(homedir(), '.local', 'share', 'epicenter-query');
}
