<script lang="ts">
	import { agentMessageText } from '@epicenter/agent';
	import { getConnectionScreen } from '@epicenter/app-shell/boot-screens';
	import { InferencePicker } from '@epicenter/app-shell/inference-picker';
	import * as Chat from '@epicenter/ui/chat';
	import { Markdown } from '@epicenter/ui/markdown';
	import { Button } from '@epicenter/ui/button';
	import { Textarea } from '@epicenter/ui/textarea';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import SendIcon from '@lucide/svelte/icons/send';
	import SquareIcon from '@lucide/svelte/icons/square';
	import { onDestroy, onMount, untrack } from 'svelte';
	import type { AgentMessage } from '@epicenter/agent';
	import { auth } from '$lib/auth.svelte.js';
	import { createVocabChat } from '$lib/chat/session.svelte.js';
	import type { ChatHistoryData } from '$lib/data.js';
	import type { createEntriesState } from '$lib/entries.svelte.js';
	import type { InferenceCatalog } from '@epicenter/app-shell/inference-picker';
	import type { InferenceSelections } from '@epicenter/app-shell/inference-selections';
	import DictationButton from './DictationButton.svelte';

	const accountManagementUrl = auth.accountManagementUrl;
	const openConnection = getConnectionScreen();
	// The route keys this whole surface on Account identity, like its inference client.
	const account = untrack(() => {
		const state = auth.state;
		return state.status === 'signed-out' ? undefined : state.account;
	});

	let {
		conversationId,
		messages,
		accountKey,
		catalog,
		selections,
		entries,
		focus,
		visible,
		startOpening = false,
		onOpeningStarted = () => {},
	}: {
		conversationId: string;
		messages: ChatHistoryData['tables']['messages'];
		accountKey: string;
		catalog: InferenceCatalog;
		selections: InferenceSelections;
		entries: ReturnType<typeof createEntriesState>;
		focus: readonly { text: string }[];
		visible: boolean;
		startOpening?: boolean;
		onOpeningStarted?: () => void;
	} = $props();

	// The parent keys this component by conversation ID. Its loop and draft
	// end when another chat is selected; dictation ends sooner when Chat hides.
	/* svelte-ignore state_referenced_locally */
	const chat = createVocabChat({ messages, accountKey, conversationId, focus, catalog, selections });

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

	onMount(() => {
		if (startOpening) {
			onOpeningStarted();
			void chat.retry();
		}
	});
	onDestroy(() => chat[Symbol.dispose]());

	/** Land a dictated transcript in the draft for review. */
	function appendTranscript(text: string) {
		const draft = chat.inputValue.trim();
		chat.inputValue = draft ? `${draft} ${text}` : text;
	}
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

			{/if}
		{/snippet}

<div class="flex min-h-0 flex-1 flex-col">
	<div class="min-h-0 flex-1 overflow-y-auto">
		{#if chat.messages.length === 0 && !chat.streaming && !chat.isThinking}
			<div class="flex h-full items-center justify-center px-4 text-center text-muted-foreground">
				<p>The tutor is ready to open this conversation.</p>
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
					{#if lastMessage?.role === 'user' && !chat.isGenerating}
						<div class="flex justify-start px-2 py-1">
							<Button variant="ghost" class="text-muted-foreground" disabled={!chat.canServe} onclick={() => chat.retry()}>
								<RotateCcwIcon class="size-3" />
								Retry answer
						</Button>
					</div>
				{/if}
			</Chat.List>
		{/if}
	</div>
	{#if chat.messages.length === 0 && focus.length > 0 && !chat.isGenerating}
		<div class="flex justify-center border-t p-2"><Button variant="outline" disabled={!chat.canServe} onclick={() => chat.retry()}><RotateCcwIcon class="size-3" />Retry opening</Button></div>
	{/if}

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
		{#if visible}<DictationButton {catalog} disabled={chat.isGenerating} onTranscript={appendTranscript} />{/if}
		<Textarea
			class="min-h-0 max-h-32 flex-1 resize-none overflow-y-auto"
			rows={1}
			placeholder="Reply to your tutor..."
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
