<script lang="ts">
	import { agentMessageText } from '@epicenter/agent';
	import { getConnectionScreen } from '@epicenter/app-shell/boot-screens';
	import { InferencePicker } from '@epicenter/app-shell/inference-picker';
	import { CompleteError } from '@epicenter/client';
	import { tryAsync } from 'wellcrafted/result';
	import * as Chat from '@epicenter/ui/chat';
	import { Markdown } from '@epicenter/ui/markdown';
	import { Button } from '@epicenter/ui/button';
	import { Textarea } from '@epicenter/ui/textarea';
	import CheckIcon from '@lucide/svelte/icons/check';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import SendIcon from '@lucide/svelte/icons/send';
	import SquareIcon from '@lucide/svelte/icons/square';
	import { onDestroy, untrack } from 'svelte';
	import type { AgentMessage } from '@epicenter/agent';
	import {
		buildEntryCandidatePrompt,
		parseEntryCandidates,
	} from '$lib/entry-candidates';
	import { auth } from '$lib/auth.svelte.js';
	import { getVocabSurface } from '$lib/surface';
	import type { createVocabChat } from '$lib/state/chat.svelte';
	import DictationButton from './DictationButton.svelte';

	const accountManagementUrl = auth.accountManagementUrl;
	const { entries } = getVocabSurface();
	const openConnection = getConnectionScreen();
	// The route keys this whole surface on Account identity, like its inference client.
	const account = untrack(() => {
		const state = auth.state;
		return state.status === 'signed-out' ? undefined : state.account;
	});

	let { chat }: { chat: ReturnType<typeof createVocabChat> } = $props();

	const isGenerating = $derived(chat.isGenerating);

	let saveAffordance = $state.raw<{
		text: string;
		x: number;
		y: number;
	} | null>(
		null,
	);

	function handleSelectionChange() {
		const selection = document.getSelection();
		if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
			saveAffordance = null;
			return;
		}

		const text = selection.toString().trim();
		if (!text) {
			saveAffordance = null;
			return;
		}

		const anchorElement =
			selection.anchorNode instanceof Element
				? selection.anchorNode
				: selection.anchorNode?.parentElement;
		const focusElement =
			selection.focusNode instanceof Element
				? selection.focusNode
				: selection.focusNode?.parentElement;
		// Same container required, not just any two: a drag from one message
		// across the gap into another would otherwise save the whole span.
		const anchorSource = anchorElement?.closest('[data-entry-source]');
		const focusSource = focusElement?.closest('[data-entry-source]');
		if (!anchorSource || anchorSource !== focusSource) {
			saveAffordance = null;
			return;
		}

		const rect = selection.getRangeAt(0).getBoundingClientRect();
		saveAffordance = { text, x: rect.left + rect.width / 2, y: rect.top };
	}

	function saveSelectedEntry() {
		if (!saveAffordance) return;
		entries.save(saveAffordance.text);
		document.getSelection()?.removeAllRanges();
		saveAffordance = null;
	}

	/** Cap entry candidates so a long answer cannot build a runaway tray. */
	const ENTRY_CANDIDATE_CAP = 20;

	/** The transient entry candidates for one settled message, held in component
	 * memory only. Nothing here is persisted; a chosen span reaches the pool solely
	 * through `entries.save` (ADR-0102). One open at a time, like the selection
	 * affordance above. */
	let entryCandidateRequest = $state.raw<{
		messageId: string;
		status: 'loading' | 'ready' | 'error';
		candidates: string[];
		/** The completion error's own message, shown only in the `error` state so a
		 * failing local endpoint (401, refused, 500) says why. */
		detail?: string;
	} | null>(null);

	/** Aborts the in-flight entry candidate request when the user cancels or starts
	 * another one. */
	let entryCandidateAbortController: AbortController | null = null;
    onDestroy(() => entryCandidateAbortController?.abort());

	/** Ask the model for the notable spans in one settled message and open the
	 * tray with them. It is a one-shot completion (`complete`), so it writes no
	 * transcript turn and stores no gloss or provenance: the response lives only in
	 * `entryCandidateRequest.candidates` until the user saves or dismisses it. */
	async function suggestEntries(messageId: string, passage: string) {
		// Abort any prior request still in flight so it stops consuming the endpoint;
		// its result is dropped by the stale-message guard below regardless.
		entryCandidateAbortController?.abort();
		const model = chat.target?.model;
		if (!model) {
			entryCandidateAbortController = null;
			entryCandidateRequest = {
				messageId,
				status: 'error',
				candidates: [],
				detail: 'No model selected.',
			};
			return;
		}
		const controller = new AbortController();
		entryCandidateAbortController = controller;
		entryCandidateRequest = { messageId, status: 'loading', candidates: [] };
		const connection = catalog.resolve(chat.target);
		if (!connection || connection.source === 'runtime') {
			entryCandidateRequest = { messageId, status: 'error', candidates: [], detail: 'Choose a connection in the model menu before suggesting entries.' };
			return;
		}
        const { data, error } = await tryAsync({
            try: async () => {
                const result = await connection.client.chat.completions.create({ model, messages: [{ role: 'system', content: buildEntryCandidatePrompt() }, { role: 'user', content: passage }], stream: false }, { signal: controller.signal });
                const text = result.choices?.[0]?.message?.content;
                if (typeof text !== 'string') throw new Error('The response contained no text.');
                return text;
            },
            catch: cause => CompleteError.TransportFailed({ cause }),
        });
		// A dismiss, a cancel, or a request for another message may have superseded
		// this one while it was in flight; drop the stale result rather than
		// overwrite. (A cancel nulls the request, so an aborted request lands here.)
		if (controller.signal.aborted || entryCandidateRequest?.messageId !== messageId) return;
		if (error) {
			entryCandidateRequest = {
				messageId,
				status: 'error',
				candidates: [],
				detail: error.message,
			};
			return;
		}
		entryCandidateRequest = {
			messageId,
			status: 'ready',
			candidates: parseEntryCandidates(data).slice(0, ENTRY_CANDIDATE_CAP),
		};
	}

	/** Close the entry candidate tray, aborting the request first when one is still loading. */
	function dismissEntryCandidates() {
		entryCandidateAbortController?.abort();
		entryCandidateAbortController = null;
		entryCandidateRequest = null;
	}

	/** Whether a candidate is already in the pool, derived from entries so it is
	 * never stored on the candidate and reflects a save immediately. */
	function isEntrySaved(text: string): boolean {
		return entries.entries.some((entry) => entry.text === text);
	}

	/** Land a dictated transcript in the draft for review. */
	function appendTranscript(text: string) {
		const draft = chat.inputValue.trim();
		chat.inputValue = draft ? `${draft} ${text}` : text;
	}
	const { catalog } = getVocabSurface();
	const lastMessage = $derived(chat.messages.at(-1));
</script>

<svelte:document onselectionchange={handleSelectionChange} />

{#if saveAffordance}
	<button
		type="button"
		class="fixed z-50 -translate-x-1/2 -translate-y-full rounded border bg-popover px-2 py-1 text-xs shadow-sm"
		style="left: {saveAffordance.x}px; top: {saveAffordance.y - 6}px;"
		onpointerdown={(event) => event.preventDefault()}
		onclick={saveSelectedEntry}
	>
		Save entry
	</button>
{/if}

{#snippet message(msg: AgentMessage, streaming: boolean)}
			{#if msg.role === 'user' || streaming}
					<!-- Render Markdown only after the answer settles. -->
				<div class="whitespace-pre-wrap">{agentMessageText(msg)}</div>
			{:else}
				<div data-entry-source>
						<Markdown content={agentMessageText(msg)} />
				</div>

				{#if entryCandidateRequest?.messageId === msg.id}
					<div class="mt-2 rounded-md border bg-muted/40 p-2">
						{#if entryCandidateRequest.status === 'loading'}
							<div class="flex items-center justify-between gap-2">
								<p class="text-xs text-muted-foreground">Finding suggestions...</p>
								<Button variant="ghost" size="sm" onclick={dismissEntryCandidates}>
									Cancel
								</Button>
							</div>
						{:else if entryCandidateRequest.status === 'error'}
							<div class="flex items-center justify-between gap-2">
								<div class="min-w-0">
									<p class="text-xs text-muted-foreground">
										Couldn't read entries from this message.
									</p>
									{#if entryCandidateRequest.detail}
										<p
											class="mt-0.5 truncate text-xs text-muted-foreground/70"
											title={entryCandidateRequest.detail}
										>
											{entryCandidateRequest.detail}
										</p>
									{/if}
								</div>
								<div class="flex shrink-0 gap-1">
									<Button
										variant="ghost"
										size="sm"
										onclick={() => suggestEntries(msg.id, agentMessageText(msg))}
									>
										Try again
									</Button>
									<Button variant="ghost" size="sm" onclick={dismissEntryCandidates}>
										Dismiss
									</Button>
								</div>
							</div>
						{:else if entryCandidateRequest.candidates.length === 0}
							<div class="flex items-center justify-between gap-2">
								<p class="text-xs text-muted-foreground">No entries found here.</p>
								<Button variant="ghost" size="sm" onclick={dismissEntryCandidates}>
									Dismiss
								</Button>
							</div>
						{:else}
							<div class="mb-1.5 flex items-center justify-between">
								<span class="text-xs text-muted-foreground">
									Tap an entry to save it
								</span>
								<Button variant="ghost" size="sm" onclick={dismissEntryCandidates}>
									Dismiss
								</Button>
							</div>
							<div class="flex flex-wrap gap-1.5">
								{#each entryCandidateRequest.candidates as candidate (candidate)}
									{@const saved = isEntrySaved(candidate)}
									<button
										type="button"
										class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-sm {saved
											? 'text-muted-foreground'
											: 'hover:bg-accent'}"
										disabled={saved}
										onclick={() => entries.save(candidate)}
									>
										{#if saved}<CheckIcon class="size-3" />{/if}
										{candidate}
									</button>
								{/each}
							</div>
						{/if}
					</div>
				{:else}
					<button
						type="button"
						class="mt-1.5 text-xs text-muted-foreground hover:text-foreground"
						onclick={() => suggestEntries(msg.id, agentMessageText(msg))}
					>
						Suggest entries
					</button>
				{/if}
			{/if}
		{/snippet}

<div class="flex min-h-0 flex-1 flex-col">
	<div class="min-h-0 flex-1 overflow-y-auto">
		{#if chat.messages.length === 0 && !chat.streaming}
			<div class="flex h-full items-center justify-center px-4 text-center text-muted-foreground">
				<p>Ask about an English word or phrase, then save what you want to remember.</p>
			</div>
		{:else}
			<Chat.List>
				{#each chat.messages as msg (msg.id)}
					<Chat.Bubble variant={msg.role === 'user' ? 'sent' : 'received'}>
						<Chat.BubbleMessage>{@render message(msg, false)}</Chat.BubbleMessage>
					</Chat.Bubble>
				{/each}
				{#if chat.streaming}
					<Chat.Bubble variant="received">
						<Chat.BubbleMessage>{@render message(chat.streaming, true)}</Chat.BubbleMessage>
					</Chat.Bubble>
				{:else if chat.isThinking}
					<Chat.Bubble variant="received"><Chat.BubbleMessage typing /></Chat.Bubble>
				{/if}
				{#if lastMessage && !chat.isGenerating}
					<div class="flex justify-start px-2 py-1">
						<Button variant="ghost" class="text-muted-foreground" disabled={!chat.canServe} onclick={() => chat.retry()}>
							<RotateCcwIcon class="size-3" />
							{lastMessage.role === 'user' ? 'Retry answer' : 'Another answer'}
						</Button>
					</div>
				{/if}
			</Chat.List>
		{/if}
	</div>

	{#if chat.error?.code === 'Unauthorized'}
		<div role="alert" class="flex items-center justify-between border-t px-3 py-2 text-xs text-destructive">
			<span>Sign in to use Vocab chat</span>
			<Button variant="ghost" size="sm" onclick={openConnection}>Sign in</Button>
		</div>
	{:else if chat.error?.code === 'InsufficientCredits'}
		<div role="alert" class="flex items-center justify-between border-t px-3 py-2 text-xs text-destructive">
			<span>You're out of credits</span>
			{#if account && accountManagementUrl}
				<Button variant="ghost" size="sm" onclick={() => window.open(accountManagementUrl(account).href, '_blank', 'noopener')}>Upgrade</Button>
			{/if}
		</div>
	{:else if chat.visibleError}
		<div role="alert" class="flex items-center justify-between gap-2 border-t px-3 py-2 text-xs text-destructive">
			<span>{chat.visibleError.message}</span>
			<div class="flex gap-1">
				<Button variant="ghost" size="sm" disabled={!chat.canServe} onclick={() => chat.retry()}>Retry</Button>
				<Button variant="ghost" size="sm" onclick={() => chat.dismissError()}>Dismiss</Button>
			</div>
		</div>
	{/if}

	<div class="bg-background px-2 pt-1.5">
		<InferencePicker value={chat.target} onSelect={(target) => chat.selectTarget(target)} {catalog} disabled={chat.isGenerating} />
	</div>
	{#if !chat.canServe}
		<p class="px-3 pb-1 text-xs text-muted-foreground">Choose an available model to chat.</p>
	{/if}
	<form class="flex items-end gap-1.5 border-t bg-background px-2 py-1.5" aria-label="Chat message" onsubmit={(event) => { event.preventDefault(); chat.sendMessage(); }}>
		<DictationButton disabled={isGenerating} onTranscript={appendTranscript} />
		<Textarea
			class="min-h-0 max-h-32 flex-1 resize-none overflow-y-auto"
			rows={1}
			placeholder="Ask about an English word or phrase..."
			aria-label="Message input"
			bind:value={chat.inputValue}
			onkeydown={(event: KeyboardEvent) => {
				if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
					event.preventDefault();
					chat.sendMessage();
				}
			}}
		/>
		{#if chat.isGenerating}
			<Button variant="outline" size="icon-lg" type="button" onclick={() => chat.stop()} aria-label="Stop generating"><SquareIcon /></Button>
		{:else}
			<Button type="submit" size="icon-lg" disabled={!chat.canSend} aria-label="Send message"><SendIcon /></Button>
		{/if}
	</form>
</div>
