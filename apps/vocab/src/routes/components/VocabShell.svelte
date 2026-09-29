<script lang="ts">
	import { createBrowserInferenceSelections } from '@epicenter/app-shell/inference-selections';
	import { createInferenceCatalog } from '@epicenter/app-shell/inference-picker';
	import { PersistenceNotice } from '@epicenter/app-shell/persistence-notice';
	import { AccountPopover } from '@epicenter/app-shell/account-popover';
	import { toHostedCatalog } from '@epicenter/constants/ai-providers';
	import { fromData } from '@epicenter/svelte';
	import { Button } from '@epicenter/ui/button';
	import { LightSwitch } from '@epicenter/ui/light-switch';
	import { onDestroy } from 'svelte';
	import { auth } from '$lib/auth.svelte.js';
	import { listChats, startChat } from '$lib/chat/messages.js';
	import { VOCAB_MODEL } from '$lib/data.js';
	import { createEntriesState } from '$lib/entries.svelte.js';
	import type { openVocabResources } from '$lib/resources.js';
	import ConversationView from './ConversationView.svelte';
	import FocusWords from './FocusWords.svelte';
	import WordsView from './WordsView.svelte';

	let { data: opened }: { data: Awaited<ReturnType<typeof openVocabResources>> } = $props();
	/* svelte-ignore state_referenced_locally */
	const personal = fromData(opened.personal);
	/* svelte-ignore state_referenced_locally */
	const local = fromData(opened.local);
	/* svelte-ignore state_referenced_locally */
	const entries = createEntriesState({ data: personal });
	/* svelte-ignore state_referenced_locally */
	const catalog = createInferenceCatalog({ ai: opened.inference, signal: opened.signal, hostedModels: toHostedCatalog([VOCAB_MODEL]) });
	/* svelte-ignore state_referenced_locally */
	const selections = createBrowserInferenceSelections('vocab', opened.account);
	/* svelte-ignore state_referenced_locally */
	const accountKey = JSON.stringify([opened.account.authorityId, opened.account.principalId]);
	const chats = $derived(listChats(local.tables.chats.rows, local.tables.messages.rows, accountKey));
	let selectedChatId = $state<string | null>(null);
	let view = $state<'words' | 'chat'>('words');
	let historyOpen = $state(false);
	let focusOpen = $state(false);
	let openingId = $state<string | null>(null);
	const selectedChat = $derived(chats.find((chat) => chat.id === selectedChatId));

	function begin(focus: { entryId: string; text: string }[]) {
		const chat = startChat(local.tables.chats, accountKey, focus);
		selectedChatId = chat.id;
		openingId = chat.id;
		view = 'chat';
	}
	function openChat(id: string) {
		selectedChatId = id;
		openingId = null;
		historyOpen = false;
		view = 'chat';
	}
	onDestroy(() => { entries[Symbol.dispose](); selections[Symbol.dispose](); });
</script>

<PersistenceNotice persistence={personal.persistence} />
<PersistenceNotice persistence={local.persistence} />
<div class="flex h-dvh min-w-0 flex-col">
	<header class="flex items-center justify-between border-b px-4 py-2">
		<div class="flex items-center gap-2"><h1 class="text-lg font-semibold">Vocab</h1><Button size="sm" variant={view === 'words' ? 'default' : 'ghost'} onclick={() => view = 'words'}>Words</Button><Button size="sm" variant={view === 'chat' ? 'default' : 'ghost'} disabled={chats.length === 0} onclick={() => { view = 'chat'; historyOpen = true; }}>Chat</Button></div>
		<div class="flex items-center gap-1"><LightSwitch variant="ghost" /><AccountPopover {auth} syncNoun="entries" /></div>
	</header>
	<div class="min-h-0 flex-1" class:hidden={view !== 'words'}><WordsView {entries} onStart={begin} /></div>
	<div class="flex min-h-0 flex-1" class:hidden={view !== 'chat'}>
		<aside class="hidden w-56 shrink-0 overflow-y-auto border-r p-3 md:block" aria-label="Chat history">
			<h2 class="mb-2 text-sm font-semibold">Chats on this device</h2>
			{#each chats as chat (chat.id)}<Button class="mb-1 w-full justify-start truncate" variant={chat.id === selectedChatId ? 'secondary' : 'ghost'} onclick={() => openChat(chat.id)}>{chat.title}</Button>{/each}
		</aside>
		<div class="flex min-w-0 flex-1 flex-col">
			<div class="flex items-center gap-2 border-b px-3 py-2 md:hidden"><Button size="sm" variant="outline" onclick={() => historyOpen = !historyOpen}>History</Button><Button size="sm" variant="outline" onclick={() => focusOpen = !focusOpen}>Focus</Button></div>
			{#if historyOpen || !selectedChatId}<nav class="max-h-44 overflow-y-auto border-b p-2 md:hidden" aria-label="Chat history">{#each chats as chat (chat.id)}<Button class="w-full justify-start" variant="ghost" onclick={() => openChat(chat.id)}>{chat.title}</Button>{/each}</nav>{/if}
			{#if focusOpen && selectedChat}<div class="border-b p-3 md:hidden"><FocusWords focus={selectedChat.focus} {entries} /></div>{/if}
			{#if !selectedChatId}<p class="m-auto text-center text-muted-foreground">Choose a chat from history.</p>{/if}
			{#if selectedChatId && selectedChat}
				{#key selectedChatId}<ConversationView conversationId={selectedChatId} messages={local.tables.messages} {accountKey} {catalog} {selections} {entries} focus={selectedChat.focus} visible={view === 'chat'} startOpening={openingId === selectedChatId} onOpeningStarted={() => openingId = null} />{/key}
			{/if}
		</div>
		<aside class="hidden w-60 shrink-0 overflow-y-auto border-l p-3 md:block" aria-label="Focus words">
			{#if selectedChat}<FocusWords focus={selectedChat.focus} {entries} />{/if}
		</aside>
	</div>
</div>
