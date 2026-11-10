<script lang="ts">
	import { page } from '$app/state';
	import { Toaster } from '@epicenter/ui/sonner';
	import { ModeWatcher } from 'mode-watcher';
	import ConversationList from '$lib/ConversationList.svelte';
	import '../app.css';

	let { children } = $props();
</script>

<svelte:head><title>Messages</title></svelte:head>

<div class="flex h-dvh flex-col bg-background text-foreground">
	<p class="border-b bg-muted px-4 py-2 text-center text-xs">
		Demo: fictional conversations. Nothing reaches Beeper.
	</p>
	<div class="mx-auto flex min-h-0 w-full max-w-6xl flex-1">
		<aside
			class="min-h-0 w-full overflow-y-auto border-r md:block md:w-80 md:shrink-0 {page.params.chat ? 'hidden' : ''}"
		>
			<ConversationList />
		</aside>
		<main class="min-h-0 min-w-0 flex-1 {page.params.chat ? '' : 'hidden md:block'}">
			{@render children()}
		</main>
	</div>
</div>

<Toaster position="bottom-center" />
<ModeWatcher />
