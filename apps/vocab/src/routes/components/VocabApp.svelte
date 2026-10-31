<script lang="ts">
	import { createBrowserInferenceSelections } from '@epicenter/ai/selections';
	import { createInferenceCatalog } from '@epicenter/ai/picker';
	import { toHostedCatalog } from '@epicenter/constants/ai-providers';
	import { Button } from '@epicenter/ui/button';
	import { LightSwitch } from '@epicenter/ui/light-switch';
	import { toast } from '@epicenter/ui/sonner';
	import BookOpenIcon from '@lucide/svelte/icons/book-open';
	import MessageCircleIcon from '@lucide/svelte/icons/message-circle';
	import { onDestroy } from 'svelte';
	import type { Account } from '@epicenter/auth';
	import { type FocusItem, VOCAB_MODEL } from '$lib/data.js';
	import { openVocabInference } from '$lib/inference.js';
	import { createVocab, type VocabLists } from '$lib/vocab.svelte.js';
	import AccountMenu from './AccountMenu.svelte';
	import ConversationView from './ConversationView.svelte';
	import FocusWords from './FocusWords.svelte';
	import WordsView from './WordsView.svelte';

	// One account for this component's life (undefined signed out): the root
	// mounts a new Vocab for a new account. Signed in, the lists include the
	// learner's repository; signed out, they are this browser's files alone.
	let { lists, account }: { lists: VocabLists; account: Account | undefined } = $props();
	// svelte-ignore state_referenced_locally
	const { entries, chats } = createVocab(lists, { uploads: account !== undefined });

	// The account also adds hosted models. The endpoints connected on this
	// device and the chosen model are the same either way.
	// svelte-ignore state_referenced_locally
	const tutorAccount = account;
	const departure = new AbortController();
	const sources = openVocabInference(tutorAccount);
	const catalog = createInferenceCatalog({ ai: sources, signal: departure.signal, hostedModels: toHostedCatalog([VOCAB_MODEL]) });
	const selections = createBrowserInferenceSelections('vocab');
	/** Where the words are, in a line. */
	const where = $derived.by(() => {
		if (account === undefined) return 'On this device';
		const waiting = entries.words.filter((word) => word.waiting).length;
		if (lists.entries.repositoryError) return 'Offline: new words wait to upload';
		return waiting > 0 ? `Uploading ${waiting} ${waiting === 1 ? 'word' : 'words'}…` : 'In your repository';
	});

	const VIEWS = [
		{ id: 'words', label: 'Words', icon: BookOpenIcon },
		{ id: 'chat', label: 'Chat', icon: MessageCircleIcon },
	] as const;
	let selectedChatId = $state<string | null>(null);
	let view = $state<'words' | 'chat'>('words');
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
		view = 'chat';
		return true;
	}
	function openChat(id: string) {
		if (id === selectedChatId) {
			historyOpen = false;
			view = 'chat';
			return;
		}
		selectedChatId = id;
		openingId = null;
		historyOpen = false;
		view = 'chat';
	}
	onDestroy(() => {
		departure.abort();
		selections[Symbol.dispose]();
		void sources.then(({ account, connections }) => Promise.allSettled([account?.close(), connections?.close()]));
	});

</script>

<div class="flex h-dvh min-w-0 flex-col">
	<!--
		One nav at every width, moved by CSS alone. Below md the header is
		`contents`, so the brand row and the nav are rows of this column and the
		nav is ordered last: a bottom bar in the page flow. From md up the brand
		row is `contents` instead, so the header is one row: brand, nav, then the
		theme and account controls.
	-->
	<header class="contents md:flex md:items-center md:gap-2 md:border-b md:px-4 md:py-2">
		<div class="flex items-center justify-between gap-2 border-b px-4 py-2 md:contents">
			<h1 class="text-lg font-semibold">Vocab</h1>
			<span class="text-xs text-muted-foreground" role="status" data-testid="where">{where}</span>
			<div class="flex items-center gap-1 md:order-last md:ml-auto"><LightSwitch variant="ghost" /><AccountMenu /></div>
		</div>
		<!--
			Chat resumes the open chat; with none open, the chat view shows the
			history to pick from. The bottom inset is zero unless the page is laid
			out under the home indicator.
		-->
		<nav class="flex gap-1 max-md:order-last max-md:border-t max-md:border-sidebar-border max-md:bg-sidebar max-md:px-1 max-md:pt-1 max-md:pb-[calc(--spacing(1)+env(safe-area-inset-bottom))]" aria-label="Views">
			{#each VIEWS as item (item.id)}
				<Button
					size="sm"
					variant="ghost"
					class="aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-sidebar-accent-foreground max-md:h-auto max-md:flex-1 max-md:flex-col max-md:gap-0.5 max-md:py-1.5 max-md:text-xs"
					aria-current={view === item.id ? 'page' : undefined}
					disabled={item.id === 'chat' && chatSummaries.length === 0}
					onclick={() => view = item.id}
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
	<div class="min-h-0 flex-1" class:hidden={view !== 'words'}><WordsView {entries} {starting} onStart={begin} /></div>
	<div class="flex min-h-0 flex-1" class:hidden={view !== 'chat'}>
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
				{#key selectedChatId}<ConversationView chatId={selectedChatId} account={tutorAccount} messages={lists.messages} {catalog} {selections} {entries} focus={selectedChat.focus} visible={view === 'chat'} startOpening={openingId === selectedChatId} onOpeningStarted={() => openingId = null} />{/key}
			{/if}
		</div>
		<aside class="hidden w-60 shrink-0 overflow-y-auto border-l p-3 md:block" aria-label="Focus words">
			{#if selectedChat}<FocusWords focus={selectedChat.focus} {entries} />{/if}
		</aside>
	</div>
</div>
