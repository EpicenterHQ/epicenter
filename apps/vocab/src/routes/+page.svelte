<script lang="ts">
	import { createAgentChatState } from '@epicenter/app-shell/agent-chat';
	import { fromKv } from '@epicenter/svelte';
	import { Button } from '@epicenter/ui/button';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { VOCAB_MODEL, VOCAB_SYSTEM_PROMPT } from '@epicenter/vocab';
	import { onDestroy } from 'svelte';
	import { buildPracticePrompt } from '$lib/practice';
	import { inferenceConnections } from '$lib/state/inference-connections.svelte';
	import { vocab } from '$lib/vocab';
	import ConversationView from './components/ConversationView.svelte';
	import VocabSidebar from './components/VocabSidebar.svelte';

	const showReadings = fromKv(vocab.kv, 'showReadings');

	// The shared chat registry (ADR-0047/0059) with Vocab's variation injected:
	// capability-free (no tools, no approval), one general multilingual system
	// prompt, and the hosted VOCAB_MODEL as the default a new conversation starts
	// on. The active conversation lives in internal state (Vocab has no URL seam).
	const chat = createAgentChatState({
		table: vocab.tables.conversations,
		whenLoaded: vocab.whenReady,
		connections: inferenceConnections,
		agent: {
			buildSystemPrompts: () => [VOCAB_SYSTEM_PROMPT],
			defaultModel: VOCAB_MODEL,
		},
	});

	onDestroy(() => chat[Symbol.dispose]());

	/** Compile the chosen entries into a practice turn and send it. Focus lands in
	 * the active conversation, opening one only when none exists. The passage
	 * comes back under the tutor system prompt; nothing is written to the entries. */
	async function practice(entryTexts: string[]) {
		if (entryTexts.length === 0) return;
		if (!chat.active) await chat.createConversation();
		chat.active?.sendMessage(buildPracticePrompt(entryTexts));
	}
</script>

<Sidebar.Provider>
	<VocabSidebar
		conversations={chat.conversations}
		activeConversationId={chat.activeConversationId}
		onCreate={() => void chat.createConversation().catch(reportError)}
		onSwitch={(conversationId) => chat.switchTo(conversationId)}
		onPractice={practice}
		generating={chat.active?.isLoading ?? false}
	/>

	<main class="flex h-dvh flex-1 flex-col">
		<header class="flex items-center justify-between border-b px-4 py-3">
			<div class="flex items-center gap-3">
				<Sidebar.Trigger />
				<h1 class="text-lg font-semibold">Vocab</h1>
			</div>

			<div class="flex items-center gap-2">
				<Button
					variant={showReadings.current ? 'default' : 'outline'}
					size="sm"
					onclick={() => (showReadings.current = !showReadings.current)}
					aria-pressed={showReadings.current}
					aria-label="Toggle pronunciation readings"
				>
					{showReadings.current ? 'Hide readings' : 'Show readings'}
				</Button>
			</div>
		</header>

		<ConversationView active={chat.active} showReadings={showReadings.current} />
	</main>
</Sidebar.Provider>
