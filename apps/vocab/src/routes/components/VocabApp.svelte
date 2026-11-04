<!--
	Vocab over the words, chats and messages the variant's root set
	(`getEntryList`, `getChatList`, `getMessageList`): a header with the
	variant's account of its store and the account (`Chrome`), then Words and
	Chat over them. Every component under it reads and writes only through
	them, so the root alone decides the store.
-->
<script lang="ts">
	import { auth } from '#platform/auth';
	import { Chrome } from '#platform/root';
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import BookOpenIcon from '@lucide/svelte/icons/book-open';
	import MessageCircleIcon from '@lucide/svelte/icons/message-circle';
	import type { FocusItem } from '$lib/data.js';
	import { createVocab, getChatList, getEntryList, getMessageList } from '$lib/vocab.svelte.js';
	import ConversationView from './ConversationView.svelte';
	import FocusWords from './FocusWords.svelte';
	import WordsView from './WordsView.svelte';

	const lists = { entries: getEntryList(), chats: getChatList(), messages: getMessageList() };
	const { entries, chats, messages } = createVocab(lists);

	// The account signed in now, followed as it changes: it adds the hosted
	// models and dictation (`$lib/ai.js`). The endpoints connected on this
	// device and the chosen model are its settings, not the learner's data.
	const account = $derived(auth.state().account);
	/** Why the words or chats did not list, if they did not; the variant's `Chrome` says it. */
	const listError = $derived(lists.entries.error() ?? lists.chats.error());

	const SECTIONS = [
		{ id: 'words', label: 'Words', icon: BookOpenIcon },
		{ id: 'chat', label: 'Chat', icon: MessageCircleIcon },
	] as const;
	let selectedChatId = $state<string | null>(null);
	let section = $state<'words' | 'chat'>('words');
	let historyOpen = $state(false);
	let focusOpen = $state(false);
	let openingId = $state<string | null>(null);
	let starting = $state(false);
	const chatSummaries = $derived(chats.listing.chats);
	const selectedChat = $derived(chatSummaries.find((chat) => chat.id === selectedChatId));
	const unreadable = $derived(chats.listing.unreadable);

	/**
	 * Save the focus as a new chat, then show it. The opening it requests
	 * starts only once the chat's note is saved. Answers whether the
	 * chat started, so Words keeps the selection when it did not.
	 */
	async function begin(focus: FocusItem[]): Promise<boolean> {
		if (starting) return false;
		starting = true;
		const { data: chat, error } = await chats.start(focus);
		starting = false;
		if (error !== null) {
			toast.error('The chat was not started', { description: error.message });
			return false;
		}
		selectedChatId = chat.id;
		openingId = chat.id;
		section = 'chat';
		return true;
	}
	function openChat(id: string) {
		if (id === selectedChatId) {
			historyOpen = false;
			section = 'chat';
			return;
		}
		selectedChatId = id;
		openingId = null;
		historyOpen = false;
		section = 'chat';
	}

</script>

<div class="flex h-dvh min-w-0 flex-col">
	<!--
		One sections nav at every width, moved by CSS alone. Below md the header
		is `contents`, so the brand row and the sections nav are rows of this
		column and the sections nav is ordered last: a bottom bar in the page
		flow. From md up the brand row is `contents` instead, so the header is
		one row: brand, status, sections, then the theme and account controls.
	-->
	<header class="contents md:flex md:items-center md:gap-2 md:border-b md:px-4 md:py-2">
		<div class="flex items-center justify-between gap-2 border-b px-4 py-2 md:contents">
			<h1 class="text-lg font-semibold">Vocab</h1>
			<Chrome unreadable={listError} />
		</div>
		<!--
			Chat resumes the open chat; with none open, the chat section shows the
			history to pick from. The bottom inset is zero unless the page is laid
			out under the home indicator.
		-->
		<nav class="flex gap-1 max-md:order-last max-md:border-t max-md:border-sidebar-border max-md:bg-sidebar max-md:px-1 max-md:pt-1 max-md:pb-[calc(--spacing(1)+env(safe-area-inset-bottom))]" aria-label="Sections">
			{#each SECTIONS as item (item.id)}
				<Button
					size="sm"
					variant="ghost"
					class="aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-sidebar-accent-foreground max-md:h-auto max-md:flex-1 max-md:flex-col max-md:gap-0.5 max-md:py-1.5 max-md:text-xs"
					aria-current={section === item.id ? 'page' : undefined}
					disabled={item.id === 'chat' && chatSummaries.length === 0}
					onclick={() => section = item.id}
				><item.icon class="size-4 max-md:size-5" />{item.label}</Button>
			{/each}
		</nav>
	</header>
	{#if unreadable.length > 0}
		<details class="border-b px-3 py-2 text-xs">
			<summary class="cursor-pointer text-destructive">{unreadable.length} saved {unreadable.length === 1 ? 'file is' : 'files are'} not shown because Vocab cannot read {unreadable.length === 1 ? 'it' : 'them'}. Nothing was changed or removed.</summary>
			<ul class="mt-2 space-y-1">
				{#each unreadable as file (file.path)}<li class="break-words"><code>{file.path}</code>: {file.reason}</li>{/each}
			</ul>
		</details>
	{/if}
	<div class="min-h-0 flex-1" class:hidden={section !== 'words'}><WordsView {entries} {starting} onStart={begin} /></div>
	<div class="flex min-h-0 flex-1" class:hidden={section !== 'chat'}>
		<aside class="hidden w-56 shrink-0 overflow-y-auto border-r p-3 md:block" aria-label="Chat history">
			<h2 class="mb-2 text-sm font-semibold">Chats</h2>
			{#each chatSummaries as chat (chat.id)}<Button class="mb-1 w-full justify-start truncate" variant={chat.id === selectedChatId ? 'secondary' : 'ghost'} onclick={() => openChat(chat.id)}>{chat.title}</Button>{/each}
		</aside>
		<div class="flex min-w-0 flex-1 flex-col">
			<div class="flex items-center gap-2 border-b px-3 py-2 md:hidden"><Button size="sm" variant="outline" onclick={() => historyOpen = !historyOpen}>History</Button><Button size="sm" variant="outline" onclick={() => focusOpen = !focusOpen}>Focus</Button></div>
			{#if historyOpen || !selectedChatId}<nav class="max-h-44 overflow-y-auto border-b p-2 md:hidden" aria-label="Chat history">{#each chatSummaries as chat (chat.id)}<Button class="w-full justify-start" variant="ghost" onclick={() => openChat(chat.id)}>{chat.title}</Button>{/each}</nav>{/if}
			{#if focusOpen && selectedChat}<div class="border-b p-3 md:hidden"><FocusWords focus={selectedChat.focus} {entries} /></div>{/if}
			{#if !selectedChatId}<p class="m-auto text-center text-muted-foreground">Choose a chat from history.</p>{/if}
			{#if selectedChatId && selectedChat}
				{#key selectedChatId}<ConversationView chatId={selectedChatId} {account} {messages} {entries} focus={selectedChat.focus} visible={section === 'chat'} startOpening={openingId === selectedChatId} onOpeningStarted={() => openingId = null} />{/key}
			{/if}
		</div>
		<aside class="hidden w-60 shrink-0 overflow-y-auto border-l p-3 md:block" aria-label="Focus words">
			{#if selectedChat}<FocusWords focus={selectedChat.focus} {entries} />{/if}
		</aside>
	</div>
</div>
