/**
 * The Epicenter Home host: one local desktop chat session; built-in apps enter
 * through one verb catalog (ADR-0080). Built-in apps mount in-process through
 * app-owned catalogs (arm A); boxed apps an upstream forces off the mesh
 * may join as local stdio MCP subprocesses (arm B, Local Books today). One
 * agent loop consumes the composed catalog and never learns where a verb lives.
 *
 * Home and its built-in apps use pure record Lenses bound by one desktop
 * record owner. Sign-in remains an enhancement.
 */

import {
	type AgentEngine,
	type AgentToolCall,
	type AgentToolDefinition,
	type Approval,
	type ConversationOptions,
	type ConversationSnapshot,
	composeToolCatalogs,
	createConversation,
	defaultApprovalDecision,
	namespaceToolCatalog,
	resolveApprovedToolCall,
	type ToolCatalog,
} from '@epicenter/agent';
import {
	type AgentMessageDocumentStore,
	type Conversation,
	type ConversationsTable,
	createAgentMessageDocumentStore,
} from '@epicenter/chat';
import type { FirstAttachmentChoice } from '@epicenter/data/record';
import { InstantString } from '@epicenter/field';
import type { HoneycrispData } from '@epicenter/honeycrisp';
import { createHoneycrispCatalog } from './honeycrisp-catalog.js';
import {
	createLocalSourceCatalog,
	type LocalSourceCatalogOptions,
} from './local-source-catalog.ts';
import {
	createStdioMcpCatalog,
	type StdioMcpCatalogOptions,
} from './stdio-mcp-catalog.ts';

export type HomeHostInputs = {
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
};

export type HomeHostOptions = HomeHostInputs & {
	/** Canonical Honeycrisp Lens bound by the one desktop record owner. */
	honeycrisp: HoneycrispData;
	/** Canonical Chat Lens bound by the same desktop record owner. */
	conversations: { conversations: ConversationsTable };
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

export type HomeSessionSnapshot = {
	conversation: ConversationSnapshot;
	pendingApprovals: PendingApproval[];
	invocations: HomeInvocation[];
};

/**
 * One direct tool invocation, from command to settled outcome. This is a
 * record with a lifecycle, not an event: the host mutates `status` in place
 * and pushes a fresh snapshot. Direct invocations never touch the
 * conversation transcript; the model must not see operator-plane runs as
 * chat history.
 */
export type HomeInvocation = {
	id: string;
	toolName: string;
	status: 'running' | 'succeeded' | 'failed';
	/** The outcome's model-facing text once settled; the error text on failure. */
	content?: string;
	requestedAt: number;
	settledAt?: number;
};

/** What a session client may ask of the one host-owned session. */
export type HomeClientCommand =
	| { type: 'send'; content: string }
	| { type: 'stop' }
	| { type: 'retry' }
	| {
			/**
			 * Start a fresh session: abort any live turn and switch to a new
			 * durable conversation row. The old transcript stays in its row;
			 * reopening one is a later wave
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
export function parseHomeCommand(
	value: unknown,
): HomeClientCommand | undefined {
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

export type HomeHost = {
	/** The model-visible tool surface, for shells that list or introspect tools. */
	toolDefinitions(): AgentToolDefinition[];
	/** Read the render state owned by the host session. */
	snapshot(): HomeSessionSnapshot;
	/** Register for any conversation or approval-state change. */
	subscribe(listener: () => void): () => void;
	/** Apply one client command to the host-owned session. */
	handleCommand(command: HomeClientCommand): Promise<boolean>;
	/**
	 * Pause every command transport around the one whole-replica attachment
	 * transition. A discard also rebuilds Home over the newly empty replica.
	 */
	runRecordAttachmentTransition<T>(
		choice: FirstAttachmentChoice,
		work: () => Promise<T>,
	): Promise<T>;
	[Symbol.asyncDispose](): Promise<void>;
};

const INVOCATION_LIMIT = 20;

/**
 * Open the built-in apps, compose their catalogs, and start the one chat
 * session over them.
 */
export async function createHomeHost(
	options: HomeHostOptions,
): Promise<HomeHost> {
	// Arm A: in-process apps. Each namespace keeps same-named verbs distinct in
	// the composed surface; the prefix must not contain `__`.
	const honeycrisp = options.honeycrisp;
	const conversations = options.conversations.conversations;
	await honeycrisp.folders.scan();
	const catalogs: ToolCatalog[] = [
		namespaceToolCatalog('honeycrisp', createHoneycrispCatalog(honeycrisp)),
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
		? await createStdioMcpCatalog(options.localBooks)
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

	// Resume the most recent session; a host with no history creates one durable
	// blank conversation before opening its row document.
	let latest: Conversation | undefined;
	for (const row of (await conversations.scan()).rows) {
		if (latest === undefined || row.updatedAt > latest.updatedAt) latest = row;
	}
	const createConversationRow = () => {
		const now = InstantString.now();
		return conversations.create({
			title: 'New Chat',
			model: options.model,
			createdAt: now,
			updatedAt: now,
		});
	};
	let activeConversation = latest ?? (await createConversationRow());

	const buildConversation = (store: ConversationOptions['store']) =>
		createConversation({
			store,
			engine: options.engine,
			tools,
			approval,
			generateId: () => crypto.randomUUID(),
		});

	// The row's document is the loop's message store (ADR-0152):
	// finished messages land there and survive restarts. Loaded before the
	// loop starts so a first send never races the replayed history.
	let activeStore = createAgentMessageDocumentStore(
		await conversations.openDocument(activeConversation.id),
	);
	let conversation = buildConversation(activeStore);
	// One relay subscription that survives `clear` swapping the conversation;
	// host listeners subscribe to the host, never to a conversation instance.
	let unbindConversation = conversation.subscribe(notify);

	/**
	 * Keep the active row honest after a started turn: name it from the first
	 * user message (app-shell convention:
	 * 'New Chat' until the first user message's first 50 chars), bump recency.
	 */
	const touchConversationRow = async (content: string) => {
		const now = InstantString.now();
		const result = await conversations.update(activeConversation.id, {
			title:
				activeConversation.title === 'New Chat'
					? content.slice(0, 50)
					: activeConversation.title,
			model: options.model,
			updatedAt: now,
		});
		if (result.error !== null) throw result.error;
		if (result.data) activeConversation = result.data;
	};

	// Direct invocations outlive no one: this controller aborts any still-running
	// invoke when the host disposes, before the catalogs go away. Settlement
	// after the abort rides the catalog honoring the signal, the same contract
	// chat turns rely on; disposal never awaits invocations.
	const invokeAbort = new AbortController();
	const invocations: HomeInvocation[] = [];
	let commandQueue = Promise.resolve();
	let recordAttachmentTransition: Promise<void> | undefined;
	let commandsPaused = false;
	let disposing = false;
	const runInvocation = (toolName: string, input: AgentToolCall['input']) => {
		const invocation: HomeInvocation = {
			id: crypto.randomUUID(),
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

	async function applyCommand(command: HomeClientCommand): Promise<boolean> {
		switch (command.type) {
			case 'send': {
				const started = conversation.send(command.content);
				if (started) await touchConversationRow(command.content);
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
				const alreadyBlank = conversation.snapshot().messages.length === 0;
				conversation.stop();
				sessionApproval.cancelAll();
				if (alreadyBlank) {
					notify();
					return true;
				}
				await activeStore.whenDurable();
				const nextConversationRow = await createConversationRow();
				let nextStore: AgentMessageDocumentStore;
				try {
					nextStore = createAgentMessageDocumentStore(
						await conversations.openDocument(nextConversationRow.id),
					);
				} catch (cause) {
					await conversations.delete(nextConversationRow.id);
					throw cause;
				}
				const nextConversation = buildConversation(nextStore);
				unbindConversation();
				conversation[Symbol.dispose]();
				await activeStore[Symbol.asyncDispose]();
				activeConversation = nextConversationRow;
				activeStore = nextStore;
				conversation = nextConversation;
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
	}

	const isSessionIdle = () =>
		!conversation.snapshot().isGenerating &&
		invocations.every((invocation) => invocation.status !== 'running');

	const whenSessionIdle = (): Promise<void> => {
		if (isSessionIdle()) return Promise.resolve();
		return new Promise((resolve) => {
			const listener = () => {
				if (!isSessionIdle()) return;
				listeners.delete(listener);
				resolve();
			};
			listeners.add(listener);
			listener();
		});
	};

	async function rebuildConversationAfterDiscard(): Promise<void> {
		unbindConversation();
		conversation[Symbol.dispose]();
		await activeStore[Symbol.asyncDispose]();
		const nextConversationRow = await createConversationRow();
		const nextStore = createAgentMessageDocumentStore(
			await conversations.openDocument(nextConversationRow.id),
		);
		activeConversation = nextConversationRow;
		activeStore = nextStore;
		conversation = buildConversation(nextStore);
		unbindConversation = conversation.subscribe(notify);
		notify();
	}

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
			if (disposing || commandsPaused) return Promise.resolve(false);
			const result = commandQueue.then(() => applyCommand(command));
			commandQueue = result.then(
				() => undefined,
				() => undefined,
			);
			return result;
		},
		runRecordAttachmentTransition(choice, work) {
			if (disposing) {
				return Promise.reject(new Error('Home host is disposing'));
			}
			if (commandsPaused) {
				return Promise.reject(
					new Error('A record attachment transition is already running'),
				);
			}
			commandsPaused = true;
			const transition = (async () => {
				await commandQueue;
				conversation.stop();
				sessionApproval.cancelAll();
				await whenSessionIdle();
				await activeStore.whenDurable();
				const result = await work();
				if (choice === 'discard') await rebuildConversationAfterDiscard();
				return result;
			})();
			recordAttachmentTransition = transition.then(
				() => undefined,
				() => undefined,
			);
			return transition.finally(() => {
				commandsPaused = false;
			});
		},
		async [Symbol.asyncDispose]() {
			// The conversation first (aborts any in-flight turn and disposes the
			// store), then the subprocess, then the in-process docs.
			disposing = true;
			await recordAttachmentTransition;
			await commandQueue;
			conversation.stop();
			invokeAbort.abort();
			sessionApproval.cancelAll();
			await localBooks?.[Symbol.asyncDispose]();
			await activeStore.whenDurable();
			conversation[Symbol.dispose]();
			await activeStore[Symbol.asyncDispose]();
		},
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
			const id = crypto.randomUUID();
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
