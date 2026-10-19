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
	import { beforeNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { auth } from '$lib/auth.svelte.js';
	import { createQuery } from '@tanstack/svelte-query';
	import { type FocusItem, VOCAB_MODEL, type VocabTables } from '$lib/data.js';
	import { openVocabInference } from '$lib/inference.js';
	import { getFolder } from '@epicenter/svelte/folder';
	import { createVocab } from '$lib/vocab.svelte.js';
	import AccountMenu from './AccountMenu.svelte';
	import ConversationView from './ConversationView.svelte';
	import FocusWords from './FocusWords.svelte';
	import WordsView from './WordsView.svelte';

	// Vocab over the local folder `<FolderApp>` opened.
	const vocab = createVocab(getFolder<VocabTables>());
	const { folder, entries, chats } = vocab;
	// Observed here, so a change the folder reports reads both lists again.
	const words = createQuery(() => entries.entriesQuery());
	const chatList = createQuery(() => chats.chatsQuery());

	// The account adds hosted models and nothing else. It is read once:
	// sign-in and sign-out replace this page, and a change made in another tab
	// is offered as a reload below. The folder, the endpoints connected on this
	// device, and the chosen model are the same either way.
	const account = auth.getState().account;
	const departure = new AbortController();
	const sources = openVocabInference(account);
	const catalog = createInferenceCatalog({ ai: sources, signal: departure.signal, hostedModels: toHostedCatalog([VOCAB_MODEL]) });
	const selections = createBrowserInferenceSelections('vocab');
	const accountChanged = $derived(auth.state.account?.principalId !== account?.principalId || auth.state.account?.authorityId !== account?.authorityId);

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
	const chatSummaries = $derived(chatList.data?.chats ?? []);
	const selectedChat = $derived(chatSummaries.find((chat) => chat.id === selectedChatId));
	const unreadable = $derived(chatList.data?.unreadable ?? []);
	const loadError = $derived(words.error?.message ?? chatList.error?.message);

	/**
	 * Save the focus as a new chat, then show it. The opening it requests
	 * starts only once the folder holds the chat's file. Answers whether the
	 * chat started, so Words keeps the selection when it did not.
	 */
	async function begin(focus: FocusItem[]): Promise<boolean> {
		if (starting) return false;
		starting = true;
		const { data: chat, error } = await chats.start(focus);
		starting = false;
		if (error !== null) {
			toast.error('The chat was not started', { description: `${error.message} The tutor has not been asked.` });
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

	// Typing not yet saved, or a save or another action still running, lives
	// only in this page.
	// Leaving then is cancelled; for a reload or a closed tab, SvelteKit turns
	// the cancel into the browser's own leave confirmation.
	beforeNavigate((navigation) => {
		if (!vocab.busy) return;
		if (navigation.willUnload || navigation.to?.route.id !== page.route.id) navigation.cancel();
	});

	/** Read both lists again, after a read that failed. */
	function readAgain() {
		void vocab.queryClient.invalidateQueries({ queryKey: vocab.queries.key });
	}
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
	{#if loadError}
		<div role="alert" class="flex items-center justify-between gap-2 border-b px-3 py-2 text-xs text-destructive">
			<span>Vocab could not read its folder in this browser: {loadError}</span>
			<Button variant="ghost" size="sm" onclick={readAgain}>Read again</Button>
		</div>
	{/if}
	{#if unreadable.length > 0}
		<details class="border-b px-3 py-2 text-xs">
			<summary class="cursor-pointer text-destructive">{unreadable.length} saved {unreadable.length === 1 ? 'file is' : 'files are'} not shown because Vocab cannot read {unreadable.length === 1 ? 'it' : 'them'}. Nothing was changed or removed.</summary>
			<ul class="mt-2 space-y-1">
				{#each unreadable as file (file.path)}<li class="break-words"><code>{file.path}</code>: {file.reason}</li>{/each}
			</ul>
		</details>
	{/if}
	{#if accountChanged}
		<div role="status" class="flex items-center justify-between gap-2 border-b px-3 py-2 text-xs">
			<span>Your sign-in changed in another tab. Reload to use it for the tutor. Your words and chats are not affected.</span>
			<Button variant="ghost" size="sm" onclick={() => location.reload()}>Reload</Button>
		</div>
	{/if}
	<div class="min-h-0 flex-1" class:hidden={view !== 'words'}><WordsView {entries} {starting} onStart={begin} /></div>
	<div class="flex min-h-0 flex-1" class:hidden={view !== 'chat'}>
		<aside class="hidden w-56 shrink-0 overflow-y-auto border-r p-3 md:block" aria-label="Chat history">
			<h2 class="mb-2 text-sm font-semibold">Chats in this browser</h2>
			{#each chatSummaries as chat (chat.id)}<Button class="mb-1 w-full justify-start truncate" variant={chat.id === selectedChatId ? 'secondary' : 'ghost'} onclick={() => openChat(chat.id)}>{chat.title}</Button>{/each}
		</aside>
		<div class="flex min-w-0 flex-1 flex-col">
			<div class="flex items-center gap-2 border-b px-3 py-2 md:hidden"><Button size="sm" variant="outline" onclick={() => historyOpen = !historyOpen}>History</Button><Button size="sm" variant="outline" onclick={() => focusOpen = !focusOpen}>Focus</Button></div>
			{#if historyOpen || !selectedChatId}<nav class="max-h-44 overflow-y-auto border-b p-2 md:hidden" aria-label="Chat history">{#each chatSummaries as chat (chat.id)}<Button class="w-full justify-start" variant="ghost" onclick={() => openChat(chat.id)}>{chat.title}</Button>{/each}</nav>{/if}
			{#if focusOpen && selectedChat}<div class="border-b p-3 md:hidden"><FocusWords focus={selectedChat.focus} {entries} /></div>{/if}
			{#if !selectedChatId}<p class="m-auto text-center text-muted-foreground">Choose a chat from history.</p>{/if}
			{#if selectedChatId && selectedChat}
				{#key selectedChatId}<ConversationView chatId={selectedChatId} {folder} write={chats.messageWriter(selectedChatId)} {catalog} {selections} {entries} focus={selectedChat.focus} visible={view === 'chat'} startOpening={openingId === selectedChatId} onOpeningStarted={() => openingId = null} />{/key}
			{/if}
		</div>
		<aside class="hidden w-60 shrink-0 overflow-y-auto border-l p-3 md:block" aria-label="Focus words">
			{#if selectedChat}<FocusWords focus={selectedChat.focus} {entries} />{/if}
		</aside>
	</div>
</div>
