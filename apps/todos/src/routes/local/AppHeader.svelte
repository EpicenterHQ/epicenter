<!--
	The header over this device's local folder: the app's name and whether
	a folder write is in progress. It offers no Save version, Sync, or
	Connect: this storage keeps no history and syncs nowhere yet. Standalone
	Todos also offers Open in Epicenter (`open-in-epicenter.ts`).
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import StatusPopover from '@epicenter/svelte/status-popover';
	import StatusRow from '@epicenter/svelte/status-row';
	import { saveLine } from '@epicenter/svelte/status-line';
	import { getFolder } from '$lib/folder.js';
	import { onMount } from 'svelte';
	import {
		currentShell,
		type HandoffStatus,
		offersOpenInEpicenter,
		openInEpicenter,
	} from './open-in-epicenter';

	const folder = getFolder();
	let { pendingNewTodo }: { pendingNewTodo: boolean } = $props();

	const status = $derived.by(() => {
		const line = saveLine(folder.saving);
		return pendingNewTodo && line.tone === 'neutral'
			? { label: 'Todo not added', tone: 'warning' as const }
			: line;
	});

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
	<!-- On narrow screens the list itself says what this is; the width goes to status. -->
	<h1 class="text-sm font-semibold max-sm:sr-only">Todos</h1>
	<StatusPopover summary={status} details={[{ name: 'Saving', testid: 'status-files', line: status }]}>
		<StatusRow name="Where">
			<span class="font-medium" data-testid="status-folder">This device</span>
			<span class="mt-0.5 block text-xs text-muted-foreground">
				Stored locally on this device. Todos does not sync these todos to other devices yet.
			</span>
		</StatusRow>
	</StatusPopover>
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
