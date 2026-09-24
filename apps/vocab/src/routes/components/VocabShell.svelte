<script lang="ts">
	import { createBrowserInferenceSelections } from '@epicenter/app-shell/inference-selections';
	import type { openVocabResources } from '$lib/resources.js';
	import { createDictation } from '$lib/state/dictation.svelte';
	import { PersistenceNotice } from '@epicenter/app-shell/persistence-notice';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { VOCAB_MODEL } from '$lib/data';
	import { fromData } from '@epicenter/svelte';
	import { onDestroy } from 'svelte';
	import { runVocabMutation } from '$lib/mutation';
	import { reportBackgroundError } from '$lib/report';
	import { createVocabChat } from '$lib/state/chat.svelte';
	import { createEntriesState } from '$lib/state/entries.svelte';
	import { createInferenceCatalog } from '@epicenter/app-shell/inference-picker';
	import { toHostedCatalog } from '@epicenter/constants/ai-providers';
	import { setVocabSurface } from '$lib/surface';
	import ConversationView from './ConversationView.svelte';
	import VocabSidebar from './VocabSidebar.svelte';

	// The opened store, awake, and adapted before it was handed over. It arrives
	// as a prop rather than through a context provider, because there is one
	// route and this component only mounts under `ready`: the type carries "the
	// store is open" without a second object to own and dispose.
	//
	// The account store holds entries; the device store holds finished chat turns.
	let {
		data: opened,
	}: {
		data: Awaited<ReturnType<typeof openVocabResources>>;
	} = $props();

	// svelte-ignore state_referenced_locally
	const selections = createBrowserInferenceSelections('vocab', opened.account);

	// `fromData` runs here rather than above, because this mounts exactly once
	// per opened store and the adaptation is per store.
	/* svelte-ignore state_referenced_locally */
	const data = fromData(opened.personal);
	/* svelte-ignore state_referenced_locally */
	const localData = fromData(opened.local);

	// Read once, not `$derived`: the route mounts this exactly once per opened
	// store, so `data` never changes while this component lives.
	/* svelte-ignore state_referenced_locally */
	const entries = createEntriesState({ data });
	/* svelte-ignore state_referenced_locally */
	const catalog = createInferenceCatalog({
		ai: opened.inference,
        signal: opened.signal,
		hostedModels: toHostedCatalog([VOCAB_MODEL]),
	});
	/* svelte-ignore state_referenced_locally */
	const dictation = createDictation(async () => { await catalog.ready; return catalog.ai.account?.client ?? null; });
	setVocabSurface({ entries, catalog, dictation });

	// This mounted account owns one device-local tutor exchange. A different
	// account gets its own message rows in the same Local document.
	/* svelte-ignore state_referenced_locally */
	const chat = createVocabChat({
		data: localData,
		accountKey: JSON.stringify([opened.account.authorityId, opened.account.principalId]),
		catalog,
		selections,
	});

	onDestroy(() => {
		void dictation.close().catch(reportBackgroundError);
		chat[Symbol.dispose]();
		entries[Symbol.dispose]();
		selections[Symbol.dispose]();
	});

	function newChat() {
		if (
			(chat.messages.length > 0 || chat.isGenerating) &&
			!window.confirm('Start a new chat? This account\'s current chat on this device will be replaced.')
		) return;
		runVocabMutation(() => chat.newExchange(), 'Could not start a new chat');
	}
</script>

<PersistenceNotice persistence={data.persistence} />
<PersistenceNotice persistence={localData.persistence} />

<Sidebar.Provider>
	<VocabSidebar onNew={newChat} />

	<main class="flex h-dvh flex-1 flex-col">
		<header class="flex items-center justify-between border-b px-4 py-3">
			<div class="flex items-center gap-3">
				<Sidebar.Trigger />
				<h1 class="text-lg font-semibold">Vocab</h1>
			</div>

		</header>

		{#key chat.revision}
			<ConversationView {chat} />
		{/key}
	</main>
</Sidebar.Provider>
