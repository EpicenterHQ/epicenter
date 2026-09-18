<script lang="ts">
	import { createBrowserInferenceSelections } from '@epicenter/app-shell/inference-selections';
	import type { App } from '@epicenter/app/open';
	import { createDictation } from "$lib/state/dictation.svelte";
	import { PersistenceNotice } from '@epicenter/app-shell/persistence-notice';
	import { createAgentChatState } from '@epicenter/app-shell/agent-chat';
	import { Button } from '@epicenter/ui/button';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { VOCAB_MODEL, VOCAB_SYSTEM_PROMPT } from '$lib/data';
	import { fromData } from '@epicenter/svelte';
	import type { vocabDefinition } from '$lib/data';
	import { onDestroy } from 'svelte';
	import { runVocabMutation } from '$lib/mutation';
	import { buildPracticeOpening } from '$lib/practice';
	import { reportBackgroundError } from '$lib/report';
	import { createEntriesState } from '$lib/state/entries.svelte';
	import { createVocabConnections } from '$lib/state/inference-connections.svelte';
	import { createSettingsState } from '$lib/state/settings.svelte';
	import { setVocabSurface } from '$lib/surface';
	import ConversationView from './ConversationView.svelte';
	import VocabSidebar from './VocabSidebar.svelte';

	// The opened store, awake, and adapted before it was handed over. It arrives
	// as a prop rather than through a context provider, because there is one
	// route and this component only mounts under `ready`: the type carries "the
	// store is open" without a second object to own and dispose.
	//
	// One document, because an account is required. Everything below reads
	// `data` and never asks which one it is.
	let {
		data: opened,
		removeLocalData,
	}: {
		data: App<typeof vocabDefinition>;
		removeLocalData?: () => Promise<void>;
	} = $props();

	// svelte-ignore state_referenced_locally
	const selections = createBrowserInferenceSelections('vocab', opened.account?.identity);

	// `fromData` runs here rather than above, because this mounts exactly once
	// per opened store and the adaptation is per store.
	/* svelte-ignore state_referenced_locally */
	const data = fromData(opened.account!.personal);

	// Read once, not `$derived`: the route mounts this exactly once per opened
	// store, so `data` never changes while this component lives.
	/* svelte-ignore state_referenced_locally */
	const entries = createEntriesState({ data });
	/* svelte-ignore state_referenced_locally */
	const inferenceConnections = createVocabConnections(opened, selections);
	/* svelte-ignore state_referenced_locally */
	const dictation = createDictation(opened.account?.connection?.client ?? null);
	setVocabSurface({ entries, inferenceConnections, dictation });

	// The shared chat registry (ADR-0047/0059) with Vocab's variation injected:
	// capability-free (no tools, no approval), one general multilingual system
	// prompt, and the hosted VOCAB_MODEL as the default a new conversation starts
	// on. The active conversation lives in internal state (Vocab has no URL seam).
	/* svelte-ignore state_referenced_locally */
	const chat = createAgentChatState({
		table: data.tables.conversations,
		reportBackgroundError,
		connections: inferenceConnections,
		agent: {
			buildSystemPrompts: () => [VOCAB_SYSTEM_PROMPT],
			defaultModel: VOCAB_MODEL,
		},
	});

	/* svelte-ignore state_referenced_locally */
	const settings = createSettingsState({ data: opened.device });

	let closing: Promise<void> | undefined;
	export function close(): Promise<void> {
		closing ??= (async () => {
			try {
				await dictation.close();
			} finally {
				chat[Symbol.dispose]();
				entries[Symbol.dispose]();
				settings[Symbol.dispose]();
				selections[Symbol.dispose]();
			}
		})();
		return closing;
	}
	onDestroy(() => void close().catch(() => {}));

	/**
	 * Practice opens its own conversation, titled after the chosen entries, and
	 * the compiled turn is that conversation's first message. Whatever thread was
	 * open is left exactly as it was and stays there to return to. The passage
	 * comes back under the tutor system prompt; nothing is written to the
	 * entries.
	 */
	function practice(entryTexts: string[]) {
		if (entryTexts.length === 0) return;
		runVocabMutation(
			() => chat.createConversation(buildPracticeOpening(entryTexts)),
			'Could not start a practice session',
		);
	}
</script>

<PersistenceNotice persistence={data.persistence} />

<Sidebar.Provider>
	<VocabSidebar
		{removeLocalData}
		conversations={chat.conversations}
		activeConversationId={chat.activeConversationId}
		onCreate={() =>
			runVocabMutation(
				() => chat.createConversation(),
				'Could not start a conversation',
			)}
		onSwitch={(conversationId) => chat.switchTo(conversationId)}
		onPractice={practice}
	/>

	<main class="flex h-dvh flex-1 flex-col">
		<header class="flex items-center justify-between border-b px-4 py-3">
			<div class="flex items-center gap-3">
				<Sidebar.Trigger />
				<h1 class="text-lg font-semibold">Vocab</h1>
			</div>

			<div class="flex items-center gap-2">
				<Button
					variant={settings.showReadings ? 'default' : 'outline'}
					size="sm"
					onclick={() =>
						runVocabMutation(
							() => settings.toggleReadings(),
							'Could not save your reading preference',
						)}
					aria-pressed={settings.showReadings}
					aria-label="Toggle pronunciation readings"
				>
					{settings.showReadings ? 'Hide readings' : 'Show readings'}
				</Button>
			</div>
		</header>

		<ConversationView
			active={chat.active}
			showReadings={settings.showReadings}
		/>
	</main>
</Sidebar.Provider>
