/**
 * Reactive AI chat state shared by every chat app: the conversation registry
 * plus one client agent loop (ADR-0047) per conversation, with each app's
 * differences injected rather than forked.
 *
 * The conversation list is a `conversations` table the app spliced into its own
 * workspace shape (@epicenter/chat), in whichever document the app's root
 * chose for this generation (ADR-0233); each row's turns live in its `content`
 * node on that database document. A handle registry mirrors the table:
 * {@link createAgentChatState} opens a handle for every row and disposes one
 * whose row is gone. Each handle binds that row's content node to the loop through
 * `bindAgentConversation`; the loop streams the live turn into component state
 * and writes each finished message into the document the moment the turn ends.
 * The live turn never enters the CRDT, and the loop dies with the tab.
 *
 * Everything here is synchronous, which is what the store being synchronous
 * buys: a read is a property access on a document already in memory, a row's
 * document is already allocated beside the row (ADR-0215), and `subscribe`
 * reports a commit after the projection has caught up (ADR-0187). So there is
 * no `whenReady`, no in-flight-handle set, and no awaiting a document lease;
 * a handle exists for a row the instant the registry hears about it.
 *
 * Inference rides the OpenAI-compatible gateway (ADR-0049/0050). The engine is
 * built here, once: per turn it resolves the conversation's model (ADR-0055)
 * against this device's explicit connection selection and
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
	type AgentToolCall,
	type Approval,
	agentMessageText,
	createConversation as createAgentConversation,
	defaultApprovalDecision,
	type ToolCatalog,
} from '@epicenter/agent';
import { InstantString } from '@epicenter/app/field';
import {
	asConversationId,
	type Conversation,
	type ConversationId,
	type ConversationsTable,
	createAgentMessageStore,
} from '@epicenter/chat';
import {
	createOpenAiAgentEngine,
	type OpenAiTurnContext,
} from '@epicenter/client';
import { bindAgentConversation } from '@epicenter/svelte';
import type * as Y from '@y/y';
import { createSubscriber, SvelteMap } from 'svelte/reactivity';
import type { InferenceCatalog } from '../inference-picker/catalog.svelte.js';
import type { InferenceSelections } from '../inference-selections.js';
import type { InferenceTarget } from '../inference-target.js';

/**
 * Where the selected conversation lives, and how to change it. Injected so an
 * app can keep the active id in the URL (e.g. `?chat=`) instead of in
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

/**
 * The placeholder title a blank conversation is born with, and the only title
 * the first user message is allowed to overwrite. A conversation opened with a
 * real title (see {@link ConversationOpener}) keeps it.
 */
const UNTITLED = 'New Chat';

/**
 * What a caller composes when it opens a conversation deliberately instead of
 * handing the user a blank one, e.g. Vocab's Practice. Omitting both fields is
 * the blank-conversation path every "New Chat" button takes.
 */
export type ConversationOpener = {
	/** A real title, written at creation, so the conversation is findable in the
	 * list from the moment it exists rather than being named after the first
	 * fifty characters of a composed turn. */
	title?: string;
	/** One composed first user turn, sent through the new conversation's own
	 * handle. It never lands in whatever conversation happened to be active. */
	opening?: string;
};

/** A reactive handle for a single conversation backed by the client loop. */
export type ConversationHandle = NonNullable<AgentChatState['active']>;

/**
 * What the agent can do: the persona and capabilities an app gives its chat
 * loop. Grouped because every field varies with the app, not the device or the
 * route. The Data handles, inference catalog, and active-conversation source the loop
 * also needs are passed separately; they have different owners.
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
	reportBackgroundError,
	catalog,
	selections,
	activeConversation,
	agent: {
		buildSystemPrompts,
		toolCatalog,
		defaultModel,
		decideApproval = defaultApprovalDecision,
	},
}: {
	/**
	 * The conversations table of the document this surface chose (ADR-0233).
	 *
	 * One table, and the registry never asks which document it came from: an app
	 * with an account replica passes the account's, a signed-out one passes the
	 * device's, and a surface writes one or the other and never both. It is also
	 * where a conversation's messages come from: `get(id)` hands back the row with
	 * its log on it, which is why there is no separate document opener to
	 * inject. The row and the log beside it are one thing in one document.
	 */
	table: ConversationsTable;
	/** Report failures from subscription-driven refreshes and metadata writes. */
	reportBackgroundError(cause: unknown): void;
	/** The available inference sources for this document. */
	catalog: InferenceCatalog;
	/** Device-local destinations keyed by conversation id. */
	selections: InferenceSelections;
	/** The active-conversation source; defaults to internal `$state`. */
	activeConversation?: ActiveConversation;
	/** What the agent can do: the app's persona and capabilities. */
	agent: AgentKit;
}) {
	const observeSelections = createSubscriber((update) =>
		selections.onChange(update),
	);
	/**
	 * The conversation rows, re-read whole on every commit that touches them.
	 *
	 * `$state.raw` holding a snapshot rather than a reactive proxy: the rows are
	 * plain JSON the store hands back fresh each time, so there is nothing for
	 * fine-grained reactivity to track and a whole-array swap is the honest
	 * shape. A nonconforming row is skipped rather than surfaced; a conversation
	 * this release cannot read has no loop to drive, and the chat surface has
	 * nowhere to say so.
	 */
	let rows = $state.raw<Conversation[]>([]);

	function readRows(): void {
		// Only the conforming rows; the doc comment on `rows` says why the
		// nonconforming ones are skipped rather than surfaced.
		rows = table.rows;
	}

	const rowById = (id: ConversationId): Conversation | undefined =>
		rows.find((row) => row.id === id);

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
	function patchConversation(
		conversationId: ConversationId,
		patch: Partial<Omit<Conversation, 'id'>>,
	) {
		const { error } = table.update(conversationId, {
			...patch,
			updatedAt: InstantString.now(),
		});
		if (error !== null) reportBackgroundError(error);
	}

	// ── Handle Registry (one handle per conversation row) ──────────────

	const handles = new SvelteMap<
		ConversationId,
		ReturnType<typeof createConversationHandle>
	>();
	let disposed = false;

	/** The conversation list for a picker: handles sorted most-recent first. */
	const conversationList = $derived(
		[...handles.values()].sort((a, b) =>
			b.updatedAt.localeCompare(a.updatedAt),
		),
	);

	function createConversationHandle(
		conversationId: ConversationId,
		messages: Y.Node,
	) {
		let inputValue = $state('');
		let dismissedError = $state<string | null>(null);

		const metadata = $derived(rowById(conversationId));
		/** The conversation's model (ADR-0055), read once for both the engine turn
		 * and the picker's `model` getter. `model` is a required column, so this only
		 * falls back when the row was deleted out from under a still-live handle (a
		 * teardown microtask); it is not an "unset model" default. */
		const currentModel = $derived(metadata?.model ?? defaultModel);

		function selectedTarget() {
			observeSelections();
			const target = selections.get(conversationId);
			return target?.model === currentModel ? target : null;
		}

		function selectTarget(target: InferenceTarget) {
			selections.set(conversationId, target);
			patchConversation(conversationId, { model: target.model });
		}

		// The tool call the loop is waiting on a decision for, or null. A mutation
		// pauses the loop here (the present human is the gate, ADR-0047); a query,
		// or a tool the app's policy auto-approved, never lands here.
		let pendingApproval = $state.raw<{
			call: AgentToolCall;
			resolve: (approved: boolean) => void;
		} | null>(null);

		function settleApproval(approved: boolean) {
			const decision = pendingApproval;
			if (!decision) return;
			pendingApproval = null;
			decision.resolve(approved);
		}

		let runTarget: OpenAiTurnContext | null = null;

		function captureTarget(): boolean {
			if (convo.isGenerating) return false;
			const transport = catalog.resolve(selectedTarget());
			if (!transport || transport.source === 'runtime') return false;
			runTarget = {
				client: transport.client,
				model: transport.model,
				systemPrompts: buildSystemPrompts(),
			};
			return true;
		}

		// Bind the conversation's messages to the loop. The engine reads this
		// conversation's model and the live system prompts per turn, so a
		// mid-conversation model switch takes effect on the next answer.
		const convo = bindAgentConversation(
			createAgentConversation({
				store: createAgentMessageStore(messages),
				engine: createOpenAiAgentEngine({
					// One target is captured before send/retry and reused across tool steps.
					data: () => {
						if (!runTarget)
							throw new Error(
								'Choose an inference connection before running a turn.',
							);
						return runTarget;
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
				generateId: () => crypto.randomUUID(),
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
				// Nothing to release. The message log is a nested type on the row in
				// the one document this store holds (ADR-0295), so its lifetime is
				// the row's and holding it pins nothing.
			},

			// ── Identity and metadata (from the row) ──

			get id() {
				return conversationId;
			},

			get title() {
				return metadata?.title ?? UNTITLED;
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
			/** A local destination applies only while its model matches the synced row. */
			get target() {
				return selectedTarget();
			},
			get canServe() {
				return catalog.resolve(selectedTarget()) !== null;
			},
			selectTarget,

			/** Reset to the app's default model (the model-gap's "Use default"). The
			 * default is the factory's `defaultModel`, owned here so a thread needn't be
			 * told it a second time alongside the registry that already holds it. */
			useDefaultModel() {
				if (!catalog.accountId) return;
				selectTarget({
					connectionId: catalog.accountId,
					model: defaultModel,
				});
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
					catalog.resolve(selectedTarget()) !== null &&
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
				if (!text || convo.isGenerating) return;
				if (!captureTarget()) {
					inputValue = text;
					return;
				}
				// The loop owns the empty/mid-turn guard; gate the title write on
				// whether it actually started a turn rather than re-deriving it.
				if (!convo.send(text)) return;

				// A new attempt supersedes the dismissed error: re-arm the banner so a
				// repeat failure (even the identical message) is shown again rather than
				// silently swallowed by the earlier dismissal.
				dismissedError = null;

				// First user message names a conversation that has no name yet; a
				// conversation opened with a real title, and every later send, just
				// bumps recency (patchConversation always writes updatedAt).
				const currentTitle = metadata?.title ?? UNTITLED;
				patchConversation(conversationId, {
					title: currentTitle === UNTITLED ? text.slice(0, 50) : currentTitle,
				});
			},

			reload() {
				if (!captureTarget()) return;
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
				return deleteConversation(conversationId);
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
	function ensureHandle(conversationId: ConversationId): void {
		if (disposed || handles.has(conversationId)) return;
		// Nothing loads (ADR-0295): the message log is a nested type on the row in
		// the document this store already holds. Absent means the row went away
		// between the read and this line rather than that a conversation lacks
		// somewhere to keep its messages.
		const messages = table.body(conversationId);
		if (messages === undefined) return;
		handles.set(
			conversationId,
			createConversationHandle(conversationId, messages),
		);
		// The open resolved after the reconcile that requested it, so re-run the
		// selection rule now that the handle exists.
		if (selection.current === null || !handles.has(selection.current)) {
			selection.select(conversationId);
		}
	}

	function reconcileHandles(): void {
		readRows();
		const liveIds = new Set(rows.map(({ id }) => asConversationId(id)));
		for (const id of handles.keys()) {
			if (!liveIds.has(id)) destroyConversation(id);
		}
		for (const conversationId of liveIds) ensureHandle(conversationId);

		// Keep the selection pointed at a live handle.
		if (selection.current !== null && handles.has(selection.current)) return;
		const mostRecent = conversationList[0];
		if (mostRecent) selection.select(mostRecent.id);
	}

	// Registration is synchronous, does no I/O and never fires initially
	// (ADR-0187), so the reconcile below has already seen everything.
	const stopTable = table.subscribe(reconcileHandles);

	// Mirror the table in and guarantee a conversation to land in (a fresh
	// install has none). Judged on the ROWS rather than the handle list,
	// because handles arrive asynchronously as their documents hydrate.
	reconcileHandles();
	if (rows.length === 0) void createConversation();

	// ── Conversation CRUD ────────────────────────────────────────────

	/**
	 * Open a new conversation, carrying the active conversation's model choice
	 * forward, and select it.
	 *
	 * With a {@link ConversationOpener}, the conversation is born titled and its
	 * first turn is sent through its own handle, so a deliberately opened session
	 * never writes into whatever conversation happened to be active.
	 *
	 * Synchronous, because nothing here loads. The message log is a nested type
	 * minted in the same transaction as the row (ADR-0295), so by the time
	 * `create` returns, the row, its log and its handle all exist.
	 *
	 * The row write has no schema-error channel; a later read remains the
	 * conformance boundary.
	 */
	function createConversation(opener: ConversationOpener = {}): ConversationId {
		const nowIso = InstantString.now();
		const current =
			selection.current === null ? undefined : handles.get(selection.current);

		const row = table.create({
			title: opener.title ?? UNTITLED,
			model: current?.model ?? defaultModel,
			createdAt: nowIso,
			updatedAt: nowIso,
		});

		const id = asConversationId(row.id);
		const target = current?.target;
		if (target) selections.set(id, target);
		ensureHandle(id);
		selection.select(id);

		if (opener.opening !== undefined) {
			// Reconciling opens a handle for every live row, so a missing one means
			// the row went away underneath us. Throw rather than drop the turn: a
			// silently discarded opening is the exact defect this argument exists
			// to close, and the caller reports the failure.
			const handle = handles.get(id);
			if (!handle)
				throw new Error(
					`Conversation ${id} has no live handle; its opening turn was not sent.`,
				);
			handle.sendMessage(opener.opening);
		}
		return id;
	}

	function deleteConversation(conversationId: ConversationId): void {
		// Reports only whether a row was there to take; an already-gone
		// conversation is still truthfully deleted.
		table.delete(conversationId);
		readRows();
		destroyConversation(conversationId);

		if (selection.current === conversationId) {
			const next = conversationList[0];
			if (next) selection.select(next.id);
			else createConversation();
		}
	}

	// ── Public API ────────────────────────────────────────────────────

	return {
		[Symbol.dispose]() {
			disposed = true;
			stopTable();
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
