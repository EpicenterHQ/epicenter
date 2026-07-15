/**
 * Reactive AI chat state shared by every chat app (opensidian, tab-manager,
 * vocab): the conversation registry plus one client agent loop (ADR-0047) per
 * conversation, with each app's differences injected rather than forked.
 *
 * The conversation list is the synced `conversations` table (@epicenter/chat);
 * each row's turns live in its `messages` child doc. A handle registry mirrors
 * the table: {@link createAgentChatState} opens a handle for every row and
 * disposes one whose row is gone. Each handle binds that row's `messages` store
 * to the loop through `bindAgentConversation`; the loop streams the live turn
 * into component state and writes each finished message into the doc the moment
 * the turn ends. The live turn never enters the CRDT, and the loop dies with the
 * tab.
 *
 * Inference rides the OpenAI-compatible gateway (ADR-0049/0050). The engine is
 * built here, once: per turn it resolves the conversation's model (ADR-0055)
 * against this device's connection registry (ADR-0059, `resolveOrHosted`) and
 * reads the app's system prompts. What the agent can do is grouped into one
 * `agent` bundle ({@link AgentKit}), since every field of it varies with the
 * app's persona; the loop's other collaborators are passed alongside:
 *
 * - `agent.buildSystemPrompts`  the layered prompts an answer is generated under.
 * - `agent.toolCatalog`         the live tool surface; omit for a capability-free app.
 * - `agent.decideApproval`      the per-call approval policy; defaults to query-runs,
 *                               mutation-asks. The synchronous pause is owned here.
 * - `agent.defaultModel`        the model a brand new conversation starts on.
 * - `activeConversation`        the active-conversation source; defaults to internal
 *                               state. An app that keeps it in the URL injects its own.
 *
 * A mutation is approval-gated by a synchronous pause: the loop waits on an
 * in-client decision, recorded per handle in `pendingApproval`. The "Always
 * Allow" trust action lives in the app, composed from the handle's exposed
 * `pendingApprovalToolName` plus `approveToolCall`; this module never knows about
 * a trust set.
 *
 * The draft a user is typing lives per conversation on the handle (`inputValue`),
 * so switching conversations keeps each one's unsent text.
 */

import {
	asConversationId,
	type Conversation,
	type ConversationId,
	generateConversationId,
	type OpenedConversationMessages,
	type ConversationsTable as SqliteConversationsTable,
} from '@epicenter/chat';
import type { ConversationsTable as LegacyConversationsTable } from '@epicenter/chat/legacy';
import { createOpenAiAgentEngine } from '@epicenter/client';
import { bindAgentConversation, fromTable } from '@epicenter/svelte';
import { generateId, InstantString } from '@epicenter/workspace';
import {
	type AgentToolCall,
	type Approval,
	agentMessageText,
	createConversation as createAgentConversation,
	defaultApprovalDecision,
	type ToolCatalog,
} from '@epicenter/workspace/agent';
import { asyncWorkspaceHandle } from '@epicenter/workspace/sqlite';
import { SvelteMap } from 'svelte/reactivity';
import type { InferenceConnections } from '../inference-picker/connections.svelte.js';

/**
 * Where the selected conversation lives, and how to change it. Injected so an
 * app can keep the active id in the URL (opensidian's `?chat=`) instead of in
 * module state; omit it and the registry owns an internal `$state`. The `current`
 * getter must read a reactive source so the active handle recomputes on change.
 */
export type ActiveConversation = {
	/** The selected conversation, or null when none is selected. */
	readonly current: ConversationId | null;
	/** Select a conversation (a URL write, or an internal-state assignment). */
	select(id: ConversationId): void;
};

/** The reactive chat-state object returned by {@link createAgentChatState}. */
export type AgentChatState = ReturnType<typeof createAgentChatState>;

/** A reactive handle for a single conversation backed by the client loop. */
export type ConversationHandle = NonNullable<AgentChatState['active']>;

type ConversationsTable = LegacyConversationsTable | SqliteConversationsTable;

/**
 * What the agent can do: the persona and capabilities an app gives its chat
 * loop. Grouped because every field varies with the app, not the device or the
 * route. The workspace handles, connections, and active-conversation source the
 * loop also needs are passed separately; they have different owners.
 */
export type AgentKit = {
	/** The layered system prompts an answer is generated under, read per turn. */
	buildSystemPrompts: () => string[];
	/** The live tool surface; omit for a capability-free app (Vocab). */
	toolCatalog?: ToolCatalog;
	/** The model a brand new conversation starts on when none is carried forward. */
	defaultModel: string;
	/** The per-call approval policy; defaults to query-runs, mutation-asks. */
	decideApproval?: Approval['decide'];
};

export function createAgentChatState({
	table,
	whenLoaded = Promise.resolve(),
	connections,
	activeConversation,
	agent: {
		buildSystemPrompts,
		toolCatalog,
		defaultModel,
		decideApproval = defaultApprovalDecision,
	},
}: {
	/** The conversations table handle (`workspace.tables.conversations`). */
	table: ConversationsTable;
	/** Legacy-table hydration barrier. SQLite callers rely on the table view. */
	whenLoaded?: Promise<unknown>;
	/** The device connection registry (ADR-0059); resolves a model to a transport. */
	connections: InferenceConnections;
	/** The active-conversation source; defaults to internal `$state`. */
	activeConversation?: ActiveConversation;
	/** What the agent can do: the app's persona and capabilities. */
	agent: AgentKit;
}) {
	const isAsyncTable = asyncWorkspaceHandle in table;
	const conversationsView = isAsyncTable
		? fromTable(table as SqliteConversationsTable)
		: fromTable(table as LegacyConversationsTable);

	// The selected conversation: an injected source (a URL, say), or an internal
	// `$state` default minted only when no source is given.
	const selection: ActiveConversation =
		activeConversation ??
		(() => {
			let id = $state<ConversationId | null>(null);
			return {
				get current() {
					return id;
				},
				select(next: ConversationId) {
					id = next;
				},
			};
		})();

	/** Patch a conversation row and bump its recency in one write. */
	function updateConversation(
		conversationId: ConversationId,
		patch: Partial<Omit<Conversation, 'id'>>,
	) {
		const cells = { ...patch, updatedAt: InstantString.now() };
		if (isAsyncTable) {
			void (table as SqliteConversationsTable)
				.patch(conversationId, cells)
				.catch(reportError);
			return;
		}
		(table as LegacyConversationsTable).update(conversationId, cells);
	}

	// ── Handle Registry (one handle per conversation row) ──────────────

	const handles = new SvelteMap<
		ConversationId,
		ReturnType<typeof createConversationHandle>
	>();

	/** The conversation list for a picker: handles sorted most-recent first. */
	const conversationList = $derived(
		[...handles.values()].sort((a, b) =>
			b.updatedAt.localeCompare(a.updatedAt),
		),
	);

	function createConversationHandle(conversationId: ConversationId) {
		let inputValue = $state('');
		let dismissedError = $state<string | null>(null);

		const metadata = $derived(conversationsView.byId(conversationId));
		/** The conversation's model (ADR-0055), read once for both the engine turn
		 * and the picker's `model` getter. `model` is a required column, so this only
		 * falls back when the row was deleted out from under a still-live handle (a
		 * teardown microtask); it is not an "unset model" default. */
		const currentModel = $derived(metadata?.model ?? defaultModel);

		// The tool call the loop is waiting on a decision for, or null. A mutation
		// pauses the loop here (the present human is the gate, ADR-0047); a query,
		// or a tool the app's policy auto-approved, never lands here.
		let pendingApproval = $state<{
			call: AgentToolCall;
			resolve: (approved: boolean) => void;
		} | null>(null);

		function settleApproval(approved: boolean) {
			const decision = pendingApproval;
			if (!decision) return;
			pendingApproval = null;
			decision.resolve(approved);
		}

		// Bind the conversation's child doc to the loop. The engine reads this
		// conversation's model and the live system prompts per turn, so a
		// mid-conversation model switch takes effect on the next answer.
		const messageStore = isAsyncTable
			? (() => {
					const opened = (table as SqliteConversationsTable).docs.messages.open(
						conversationId,
					) as OpenedConversationMessages;
					return {
						set: opened.content.set,
						entries: opened.content.entries,
						observe: opened.content.observe,
						[Symbol.dispose]() {
							opened[Symbol.dispose]();
						},
					};
				})()
			: (table as LegacyConversationsTable).docs.messages.open(conversationId);
		const convo = bindAgentConversation(
			createAgentConversation({
				store: messageStore,
				engine: createOpenAiAgentEngine({
					// The conversation's model (ADR-0055) is resolved per turn against this
					// device's connection set (ADR-0059), so a switch lands on the next
					// turn. `resolveOrHosted` falls back to the hosted gateway for a model no
					// device connection serves; the UI gates sending in that case, so the
					// fallback only errors loudly rather than silently substituting a model.
					data: () => {
						const transport = connections.resolveOrHosted(currentModel);
						return {
							...transport,
							model: currentModel,
							systemPrompts: buildSystemPrompts(),
						};
					},
				}),
				tools: toolCatalog,
				approval: {
					decide: decideApproval,
					request: (call) =>
						new Promise<boolean>((resolve) => {
							pendingApproval = { call, resolve };
						}),
				},
				generateId,
			}),
		);

		// Map the loop's two-flag liveness onto the status the message list reads.
		const status = $derived.by(() => {
			if (convo.error) return 'error' as const;
			if (convo.isThinking) return 'submitted' as const;
			if (convo.isGenerating) return 'streaming' as const;
			return 'ready' as const;
		});

		return {
			[Symbol.dispose]() {
				// Unblock a pending approval so the awaiting loop unwinds, then abort.
				settleApproval(false);
				convo[Symbol.dispose]();
			},

			// ── Identity and metadata (from the row) ──

			get id() {
				return conversationId;
			},

			get title() {
				return metadata?.title ?? 'New Chat';
			},

			/** Recency for the conversation list, as the row's ISO instant. */
			get updatedAt() {
				return metadata?.updatedAt ?? '';
			},

			/** A picker preview built from the last turn. Reads the open `messages`
			 * doc, so any picker that shows this (tab-manager) requires every handle's
			 * loop to be live; that coupling is why the registry opens loops eagerly.
			 * Denormalizing this onto the conversation row would let the loop open
			 * lazily (active + in-flight only) without losing the preview. */
			get lastMessagePreview() {
				const last = convo.messages.at(-1);
				if (!last) return '';
				const text = agentMessageText(last).trim();
				return text.length > 60 ? `${text.slice(0, 60)}…` : text;
			},

			// ── Model choice (a row column) ──

			get model() {
				return currentModel;
			},
			set model(value: string) {
				updateConversation(conversationId, { model: value });
			},

			/** Reset to the app's default model (the model-gap's "Use default"). The
			 * default is the factory's `defaultModel`, owned here so a thread needn't be
			 * told it a second time alongside the registry that already holds it. */
			useDefaultModel() {
				updateConversation(conversationId, { model: defaultModel });
			},

			// ── Chat state (from the loop) ──

			get messages() {
				return convo.messages;
			},

			/** The in-flight message, rendered separately so the settled list above
			 * stays referentially inert during a turn. Null between turns. */
			get streaming() {
				return convo.streaming;
			},

			get isLoading() {
				return convo.isGenerating;
			},

			get status() {
				return status;
			},

			/** Credits are exhausted (HTTP 402); UI should prompt an upgrade. */
			get isCreditsExhausted() {
				return convo.error?.code === 'InsufficientCredits';
			},

			get isUnauthorized() {
				return convo.error?.code === 'Unauthorized';
			},

			// ── Tool approval ──

			/** The tool call awaiting the user's decision, or null. */
			get pendingApprovalCallId() {
				return pendingApproval?.call.toolCallId ?? null;
			},

			/** The name of the tool awaiting a decision, or null. An app composes
			 * its "Always Allow" from this plus {@link approveToolCall}, so the trust
			 * set stays in the app. */
			get pendingApprovalToolName() {
				return pendingApproval?.call.toolName ?? null;
			},

			approveToolCall() {
				settleApproval(true);
			},

			denyToolCall() {
				settleApproval(false);
			},

			// ── Ephemeral UI state ──

			/** The unsent draft, kept per conversation so switching preserves it. */
			get inputValue() {
				return inputValue;
			},
			set inputValue(value: string) {
				inputValue = value;
			},

			/** The whole send gate: this device serves the model, no turn is in
			 * flight, and the draft is non-empty. The one home for the rule every
			 * chat surface used to recompute against the app's connection singleton. */
			get canSend() {
				return (
					connections.canServe(currentModel) &&
					!convo.isGenerating &&
					inputValue.trim().length > 0
				);
			},

			/** The last turn's error, unless the user dismissed that exact message;
			 * a later, different error still surfaces. Centralizes the dismissal rule
			 * the call sites used to reassemble. */
			get visibleError() {
				return convo.error && convo.error.message !== dismissedError
					? convo.error
					: null;
			},

			/** Dismiss the current error by its message. A new send or a retry
			 * re-arms it (see {@link sendMessage} and {@link reload}). */
			dismissError() {
				dismissedError = convo.error?.message ?? null;
			},

			// ── Actions ──

			sendMessage(content: string) {
				const text = content.trim();
				// The loop owns the empty/mid-turn guard; gate the title write on
				// whether it actually started a turn rather than re-deriving it.
				if (!convo.send(text)) return;

				// A new attempt supersedes the dismissed error: re-arm the banner so a
				// repeat failure (even the identical message) is shown again rather than
				// silently swallowed by the earlier dismissal.
				dismissedError = null;

				// First user message names the conversation; later sends just bump
				// recency (updateConversation always writes updatedAt).
				const currentTitle = metadata?.title ?? 'New Chat';
				updateConversation(conversationId, {
					title: currentTitle === 'New Chat' ? text.slice(0, 50) : currentTitle,
				});
			},

			reload() {
				// Retrying re-arms the error banner: a repeat failure shows again
				// rather than staying hidden behind the earlier dismissal.
				dismissedError = null;
				convo.retry();
			},

			stop() {
				// A turn parked on an approval is awaiting `request`, which only the
				// user settles; unblock it (as a denial) before aborting, the same
				// order dispose uses, so Stop is never inert mid-approval.
				settleApproval(false);
				convo.stop();
			},

			delete() {
				void deleteConversation(conversationId).catch(reportError);
			},
		};
	}

	/** Dispose the loop and remove the handle for a conversation. */
	function destroyConversation(id: ConversationId) {
		handles.get(id)?.[Symbol.dispose]();
		handles.delete(id);
	}

	/**
	 * Mirror the table into the handle registry: open a handle for every row,
	 * dispose one whose row is gone, and keep a live conversation selected.
	 */
	function reconcileHandles() {
		const liveIds = new Set(conversationsView.all.map((row) => row.id));
		for (const id of handles.keys()) {
			if (!liveIds.has(id)) destroyConversation(id);
		}
		for (const id of conversationsView.all.map((c) => c.id)) {
			const conversationId = asConversationId(id);
			if (!handles.has(conversationId)) {
				handles.set(conversationId, createConversationHandle(conversationId));
			}
		}

		// Keep the selection pointed at a live handle.
		if (selection.current !== null && handles.has(selection.current)) return;
		const mostRecent = conversationList[0];
		if (mostRecent) selection.select(mostRecent.id);
	}

	const _unobserve = table.observe(() => {
		reconcileHandles();
	});
	let isDisposed = false;

	// Once the synced doc has loaded, mirror it in and guarantee a conversation
	// to land in (a fresh install has none).
	const tableReady =
		'whenReady' in conversationsView
			? conversationsView.whenReady
			: Promise.resolve();
	const whenReady = Promise.all([whenLoaded, tableReady]).then(async () => {
		if (isDisposed) return;
		reconcileHandles();
		if (conversationList.length === 0) await createConversation();
	});
	void whenReady.catch(reportError);

	reconcileHandles();

	// ── Conversation CRUD ────────────────────────────────────────────

	/**
	 * Open a new conversation, carrying the active conversation's model choice
	 * forward, and select it. The handle is created synchronously so the UI never
	 * sees a momentarily-missing active conversation.
	 */
	async function createConversation(): Promise<ConversationId> {
		if (isDisposed) throw new Error('Agent chat state is disposed');
		const nowIso = InstantString.now();
		const current =
			selection.current === null ? undefined : handles.get(selection.current);
		let id: ConversationId;
		if (isAsyncTable) {
			const row = await (table as SqliteConversationsTable).create({
				title: 'New Chat',
				model: current?.model ?? defaultModel,
				createdAt: nowIso,
				updatedAt: nowIso,
			});
			id = row.id;
		} else {
			id = generateConversationId();
			(table as LegacyConversationsTable).set({
				id,
				title: 'New Chat',
				model: current?.model ?? defaultModel,
				createdAt: nowIso,
				updatedAt: nowIso,
			});
		}
		// An async SQLite create may settle after disposal. The durable row is a
		// completed write, but no reactive handle may be resurrected afterward.
		if (isDisposed) return id;
		if (!handles.has(id)) handles.set(id, createConversationHandle(id));
		selection.select(id);
		return id;
	}

	async function deleteConversation(conversationId: ConversationId) {
		if (isAsyncTable) {
			await (table as SqliteConversationsTable).remove(conversationId);
		} else {
			(table as LegacyConversationsTable).delete(conversationId);
		}
		destroyConversation(conversationId);

		if (selection.current === conversationId) {
			const next = conversationList[0];
			if (next) selection.select(next.id);
			else await createConversation();
		}
	}

	// ── Public API ────────────────────────────────────────────────────

	return {
		/** Resolves after the initial table snapshot and first conversation exist. */
		whenReady,

		[Symbol.dispose]() {
			if (isDisposed) return;
			isDisposed = true;
			_unobserve();
			if ('whenReady' in conversationsView) {
				conversationsView[Symbol.dispose]();
			}
			for (const id of [...handles.keys()]) destroyConversation(id);
		},

		get active() {
			return selection.current === null
				? undefined
				: handles.get(selection.current);
		},

		get conversations() {
			return conversationList;
		},

		get activeConversationId() {
			return selection.current;
		},

		createConversation,

		switchTo(conversationId: ConversationId) {
			selection.select(conversationId);
		},
	};
}
