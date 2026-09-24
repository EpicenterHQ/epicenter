<script lang="ts">
	import { createBrowserInferenceSelections } from '@epicenter/app-shell/inference-selections';
	import { createInferenceCatalog } from '@epicenter/app-shell/inference-picker';
	import { PersistenceNotice } from '@epicenter/app-shell/persistence-notice';
	import { toHostedCatalog } from '@epicenter/constants/ai-providers';
	import { fromData } from '@epicenter/svelte';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { onDestroy } from 'svelte';
	import { listChats } from '$lib/chat/messages.js';
	import { VOCAB_MODEL } from '$lib/data.js';
	import { createEntriesState } from '$lib/entries.svelte.js';
	import type { openVocabResources } from '$lib/resources.js';
	import ConversationView from './ConversationView.svelte';
	import VocabSidebar from './VocabSidebar.svelte';

	// AppBoot mounts this shell for one captured account and its opened stores.
	let { data: opened }: { data: Awaited<ReturnType<typeof openVocabResources>> } = $props();
	/* svelte-ignore state_referenced_locally */
	const personal = fromData(opened.personal);
	/* svelte-ignore state_referenced_locally */
	const local = fromData(opened.local);
	/* svelte-ignore state_referenced_locally */
	const entries = createEntriesState({ data: personal });
	/* svelte-ignore state_referenced_locally */
	const catalog = createInferenceCatalog({
		ai: opened.inference,
		signal: opened.signal,
		hostedModels: toHostedCatalog([VOCAB_MODEL]),
	});
	/* svelte-ignore state_referenced_locally */
	const selections = createBrowserInferenceSelections('vocab', opened.account);
	/* svelte-ignore state_referenced_locally */
	const accountKey = JSON.stringify([opened.account.authorityId, opened.account.principalId]);
	const chats = $derived(listChats(local.tables.messages.rows, accountKey));
	let selectedChatId = $state(
		listChats(local.tables.messages.rows, accountKey)[0]?.id ?? crypto.randomUUID(),
	);

	onDestroy(() => {
		entries[Symbol.dispose]();
		selections[Symbol.dispose]();
	});
</script>

<PersistenceNotice persistence={personal.persistence} />
<PersistenceNotice persistence={local.persistence} />

<Sidebar.Provider>
	<VocabSidebar
		{entries}
		{chats}
		{selectedChatId}
		onNew={() => (selectedChatId = crypto.randomUUID())}
		onSwitch={(id) => (selectedChatId = id)}
	/>

	<main class="flex h-dvh flex-1 flex-col">
		<header class="flex items-center justify-between border-b px-4 py-3">
			<div class="flex items-center gap-3">
				<Sidebar.Trigger />
				<h1 class="text-lg font-semibold">Vocab</h1>
			</div>
		</header>

		{#key selectedChatId}
			<ConversationView
				conversationId={selectedChatId}
				messages={local.tables.messages}
				{accountKey}
				{catalog}
				{selections}
				{entries}
			/>
		{/key}
	</main>
</Sidebar.Provider>
