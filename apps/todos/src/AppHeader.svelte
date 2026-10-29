<!--
	The header over the open repository: the app's name, and a new todo's
	title typed but not added. Where the repository syncs, and what has not
	reached its server, is the shell's repository bar. Standalone Todos also
	offers Open in Epicenter (`open-in-epicenter.ts`).
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { onMount } from 'svelte';
	import {
		currentShell,
		type HandoffStatus,
		offersOpenInEpicenter,
		openInEpicenter,
	} from './open-in-epicenter';

	let { pendingNewTodo }: { pendingNewTodo: boolean } = $props();

	const shell = currentShell();
	let offered = $state(false);
	let sending = $state(false);
	let handoff = $state<HandoffStatus>();

	onMount(() => {
		void offersOpenInEpicenter(shell).then((offers) => (offered = offers));
	});

	async function send() {
		if (shell === undefined) return;
		sending = true;
		handoff = undefined;
		handoff = await openInEpicenter(shell);
		sending = false;
	}
</script>

<header class="flex h-12 shrink-0 items-center gap-1.5 border-b px-2 sm:gap-2 sm:px-3">
	<!-- On narrow screens the list itself says what this is. -->
	<h1 class="text-sm font-semibold max-sm:sr-only">Todos</h1>
	{#if pendingNewTodo}
		<p class="text-xs text-amber-600 dark:text-amber-400" role="status" data-testid="todo-pending">Todo not added</p>
	{/if}
	{#if offered}
		<div class="ml-auto flex min-w-0 items-center gap-2">
			{#if handoff !== undefined}
				<p
					role="status"
					class={[
						'min-w-0 truncate text-xs',
						handoff.tone === 'failed' ? 'text-destructive' : 'text-muted-foreground',
					]}
					title={handoff.message}
				>
					{handoff.message}
				</p>
			{/if}
			<Button variant="outline" size="sm" disabled={sending} onclick={() => void send()}>
				Open in Epicenter
			</Button>
		</div>
	{/if}
</header>
