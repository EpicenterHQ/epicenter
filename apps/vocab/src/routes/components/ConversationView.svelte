<script lang="ts">
	import { agentMessageText } from '@epicenter/agent';
	import { InferencePicker } from '@epicenter/ai/picker';
	import * as Chat from '@epicenter/ui/chat';
	import { Button } from '@epicenter/ui/button';
	import { CopyButton } from '@epicenter/ui/copy-button';
	import { Markdown } from '@epicenter/ui/markdown';
	import * as InputGroup from '@epicenter/ui/input-group';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import { toast } from '@epicenter/ui/sonner';
	import { onDestroy, onMount } from 'svelte';
	import type { AgentMessage } from '@epicenter/agent';
	import type { Account } from '@epicenter/auth';
	import { auth } from '$lib/auth.svelte.js';
	import { createVocabChat } from '$lib/chat/session.svelte.js';
	import type { MessageList } from '$lib/chat/messages.svelte.js';
	import type { Entries } from '$lib/entries.svelte.js';
	import type { InferenceCatalog } from '@epicenter/ai/picker';
	import type { InferenceSelections } from '@epicenter/ai/selections';
	import DictationButton from './DictationButton.svelte';
	import PhraseCapture from './PhraseCapture.svelte';

	const accountManagementUrl = auth.accountManagementUrl;

	let {
		chatId,
		account,
		messages,
		catalog,
		selections,
		entries,
		focus,
		visible,
		startOpening = false,
		onOpeningStarted = () => {},
	}: {
		chatId: string;
		/** The account captured when the parent opened this tutor. */
		account: Account | undefined;
		/** Every chat's finished messages. */
		messages: MessageList;
		catalog: InferenceCatalog;
		selections: InferenceSelections;
		entries: Entries;
		focus: readonly { text: string }[];
		visible: boolean;
		startOpening?: boolean;
		onOpeningStarted?: () => void;
	} = $props();

	// The parent keys this component by chat ID. Its loop and draft end when
	// another chat is selected; dictation ends sooner when Chat hides.
	/* svelte-ignore state_referenced_locally */
	const chat = createVocabChat({ messages, chatId, focus, catalog, selections });

	// The element holding the messages; phrase capture listens inside it.
	let list = $state<HTMLElement | null>(null);

	onMount(() => {
		if (startOpening) {
			onOpeningStarted();
			void chat.retry();
		}
	});
	onDestroy(() => chat[Symbol.dispose]());

	const lastMessage = $derived(chat.messages.at(-1));
	const unsavedIds = $derived(new Set(chat.unsaved.map((unsaved) => unsaved.id)));
</script>

<PhraseCapture root={list} {entries} resetKey={`${chat.messages.length}:${chat.isGenerating}`} />

{#snippet message(msg: AgentMessage, streaming: boolean)}
	{#if msg.role === 'user' || streaming}
		<!-- Render Markdown only after the answer settles. -->
		<div class="vocab-reply whitespace-pre-wrap">{agentMessageText(msg)}</div>
	{:else}
		<!-- A tutor answer is a phrase source only once its note is saved:
		     an unsaved one stays readable and copyable without the marker. -->
		{@const saved = !unsavedIds.has(msg.id)}
		<div data-phrase-source={saved ? msg.id : undefined}>
			<Markdown class="vocab-reply" content={agentMessageText(msg)} />
		</div>
		{#if saved}
			<Button class="mt-1" variant="ghost" size="xs" data-capture-skip data-save-phrase={msg.id}>Save a phrase</Button>
		{/if}
	{/if}
{/snippet}

<div class="flex min-h-0 flex-1 flex-col">
	<div class="min-h-0 flex-1 overflow-hidden" bind:this={list}>
		{#if chat.messages.length === 0 && !chat.streaming && !chat.isThinking}
			<div class="flex h-full items-center justify-center px-4 text-center text-muted-foreground">
				<p>The tutor is ready to open this conversation.</p>
			</div>
		{:else}
			<!-- vocab-check: ignore-next-line (Tailwind max-w-prose class) -->
			<Chat.List class="mx-auto max-w-prose">
				{#each chat.messages as msg (msg.id)}
					<Chat.Bubble variant={msg.role === 'user' ? 'sent' : 'received'} style={msg.role === 'user' ? undefined : 'max-width: 100%'}>
						<Chat.BubbleMessage class="min-w-0">{@render message(msg, false)}</Chat.BubbleMessage>
					</Chat.Bubble>
				{/each}
				{#if chat.streaming}
					<Chat.Bubble variant="received" style="max-width: 100%">
						<Chat.BubbleMessage class="min-w-0">{@render message(chat.streaming, true)}</Chat.BubbleMessage>
					</Chat.Bubble>
				{:else if chat.isThinking}
					<Chat.Bubble variant="received" style="max-width: 100%"><Chat.BubbleMessage typing /></Chat.Bubble>
				{/if}
					{#if lastMessage?.role === 'user' && !chat.isGenerating && chat.unsaved.length === 0}
						<div class="flex justify-start px-2 py-1">
							<Button variant="ghost" class="text-muted-foreground" disabled={!chat.canAsk} onclick={() => chat.retry()}>
								<RotateCcwIcon class="size-3" />
								Retry answer
						</Button>
					</div>
				{/if}
			</Chat.List>
		{/if}
	</div>
	{#if chat.messages.length === 0 && focus.length > 0 && !chat.isGenerating}
		<div class="flex justify-center border-t p-2"><Button variant="outline" disabled={!chat.canAsk} onclick={() => chat.retry()}><RotateCcwIcon class="size-3" />Retry opening</Button></div>
	{/if}

	{#if chat.unreadable.length > 0}
		<p role="alert" class="border-t px-3 py-2 text-xs text-destructive">
			{chat.unreadable.length} saved {chat.unreadable.length === 1 ? 'message of this chat is' : 'messages of this chat are'} not shown because Vocab cannot read {chat.unreadable.length === 1 ? 'it' : 'them'}. The tutor does not see {chat.unreadable.length === 1 ? 'it' : 'them'} either. Nothing was removed.
		</p>
	{/if}

	{#if chat.saveError}
		<!-- A storage failure, kept apart from tutor failures below: saving again never asks the tutor. -->
		<div role="alert" class="flex items-center justify-between gap-2 border-t px-3 py-2 text-xs text-destructive">
			<span>
				{#if chat.isSaving}
					Saving again...
				{:else if chat.unsaved[0]?.role === 'user'}
					Your message is not saved, so the tutor has not been asked. Copy it or save again before you leave this chat.
				{:else}
					The tutor's answer is not saved. Copy it or save again before you leave this chat.
				{/if}
			</span>
			<div class="flex gap-1">
				<Button variant="ghost" size="sm" disabled={chat.isSaving} onclick={() => chat.saveAgain()}>Save again</Button>
				<CopyButton variant="ghost" size="sm" tabindex={0} text={chat.unsaved.map(agentMessageText).join('\n\n')}>Copy</CopyButton>
			</div>
		</div>
	{/if}

	{#if chat.error?.code === 'Unauthorized'}
		<div role="alert" class="flex items-center justify-between border-t px-3 py-2 text-xs text-destructive">
			<span>This model needs you to sign in. Your words and chats stay as they are.</span>
			<Button variant="ghost" size="sm" onclick={async () => {
				const { error } = await auth.startSignIn();
				if (error !== null) toast.error('Could not sign in', { description: error.message });
			}}>Sign in</Button>
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
				<Button variant="ghost" size="sm" disabled={!chat.canAsk} onclick={() => chat.retry()}>Retry</Button>
				<Button variant="ghost" size="sm" onclick={() => chat.dismissError()}>Dismiss</Button>
			</div>
		</div>
	{/if}

	<div class="bg-background px-2 pt-1.5">
		<InferencePicker value={chat.target} onSelect={(target) => chat.selectTarget(target)} {catalog} disabled={chat.isGenerating} />
	</div>
	{#if !chat.canServe}
		<p class="px-3 pb-1 text-xs text-muted-foreground">Choose a model to chat. Connect your own endpoint in the picker{account ? '' : ", or sign in for Epicenter's hosted models"}.</p>
	{/if}
	<form class="border-t bg-background px-2 py-2" aria-label="Chat message" aria-busy={chat.isSaving} onsubmit={(event) => { event.preventDefault(); void chat.sendMessage(); }}>
		<InputGroup.Root>
			<InputGroup.Textarea
				class="max-h-40 overflow-y-auto"
				rows={2}
				placeholder="Reply to your tutor..."
				aria-label="Message input"
				aria-describedby="composer-hint"
				bind:value={chat.inputValue}
				onkeydown={(event: KeyboardEvent) => {
					if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
						event.preventDefault();
						void chat.sendMessage();
					}
				}}
			/>
			<InputGroup.Addon align="block-end">
				{#if visible && catalog.ai.account}<DictationButton {catalog} disabled={chat.isGenerating} onTranscript={(text) => {
					const draft = chat.inputValue.trim();
					chat.inputValue = draft ? `${draft} ${text}` : text;
				}} />{/if}
				<InputGroup.Text id="composer-hint" class="min-w-0 flex-1 text-xs">
					{chat.isGenerating ? 'The tutor is replying.' : 'Enter sends. Shift+Enter adds a line.'}
				</InputGroup.Text>
				{#if chat.isGenerating}
					<InputGroup.Button variant="outline" size="sm" type="button" onclick={() => chat.stop()} aria-label="Stop generating">Stop</InputGroup.Button>
				{:else}
					<InputGroup.Button type="submit" variant="default" size="sm" disabled={!chat.canSend} aria-label="Send message">Send</InputGroup.Button>
				{/if}
			</InputGroup.Addon>
		</InputGroup.Root>
	</form>
</div>
