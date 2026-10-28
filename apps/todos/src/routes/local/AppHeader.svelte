<!--
	The header over this device's repository: the app's name and, when the
	build syncs, whether edits are still waiting to reach the server, or are
	held here until their frontmatter parses. It
	offers no Save version, Sync, or Connect. Standalone Todos also offers
	Open in Epicenter (`open-in-epicenter.ts`).
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import StatusPopover from '@epicenter/svelte/status-popover';
	import StatusRow from '@epicenter/svelte/status-row';
	import { type StatusLine, syncLine } from '@epicenter/svelte/status-line';
	import { live } from '@epicenter/repository/svelte';
	import { getRepository } from '$lib/repository.js';
	import { onMount } from 'svelte';
	import {
		currentShell,
		type HandoffStatus,
		offersOpenInEpicenter,
		openInEpicenter,
	} from './open-in-epicenter';

	const repo = getRepository();
	let { pendingNewTodo, syncsTo }: { pendingNewTodo: boolean; syncsTo?: string } = $props();

	/** Files with edits the server has not answered yet, and files held here until they parse. */
	const sendingFiles = live(repo.files.live({ sync: 'sending' }));
	const heldFiles = live(repo.files.live({ sync: 'held' }));

	const status = $derived.by((): StatusLine => {
		if (pendingNewTodo) return { label: 'Todo not added', tone: 'warning' };
		if (syncsTo === undefined) return { label: 'On this device', tone: 'neutral' };
		return syncLine({ sending: sendingFiles.current?.length ?? 0, held: heldFiles.current?.length ?? 0 });
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
	<StatusPopover summary={status} details={[{ name: 'Sync', testid: 'status-files', line: status }]}>
		<StatusRow name="Where">
			<span class="font-medium" data-testid="status-folder">{syncsTo === undefined ? 'This device' : 'This device and a server'}</span>
			<span class="mt-0.5 block text-xs text-muted-foreground">
				{syncsTo === undefined
					? 'Stored on this device. This build of Todos syncs with no server.'
					: `Stored on this device and synced through ${new URL(syncsTo).host}. Edits made offline are sent when it is back.`}
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
