<!--
	The desktop window's header account of its store: the data folder on
	this computer, whether Epicenter syncs it, Sync with Epicenter until it
	does, and Choose data folder… (decisions 81 and 88). Whispering never
	syncs anything itself. The global shortcut lives here too: a press
	starts a recording, or stops the one under way, from any app, as the
	header's button does.
-->
<script lang="ts">
	import { getFolderSync } from '@epicenter/svelte/folder-sync';
	import FolderSyncActions from '@epicenter/svelte/folder-sync-actions';
	import type { StatusLine } from '@epicenter/svelte/status-line';
	import StatusPopover from '@epicenter/svelte/status-popover';
	import StatusRow from '@epicenter/svelte/status-row';
	import { Button } from '@epicenter/ui/button';
	import { onMount } from 'svelte';
	import { onShortcut } from '../platform/shortcut.tauri.svelte.js';
	import type { ChromeProps } from '../platform/types.js';
	import { headerStatus } from '../status.js';
	import { getWhispering } from '../whispering.svelte.js';

	let { unwrittenAnswers }: ChromeProps = $props();

	// DesktopRoot renders the app, and so this, only over its open data folder.
	const sync = getFolderSync();
	const whispering = getWhispering();

	const kept = $derived<StatusLine>(
		sync.state === 'synced' ? { label: 'Synced by Epicenter', tone: 'good' } : { label: 'On this computer', tone: 'neutral' },
	);
	const status = $derived(headerStatus({ unwrittenAnswers }, kept));

	onMount(() =>
		onShortcut(() => {
			if (whispering.recorder.phase === 'idle') void whispering.startRecording();
			else if (whispering.recorder.phase === 'recording') void whispering.stopRecording();
		}),
	);
</script>

<StatusPopover summary={status} details={[{ name: 'Files', testid: 'status-files', line: status }]}>
	<StatusRow name="Kept in">
		<span class="font-medium" data-testid="status-where">This computer</span>
		<span class="mt-0.5 block break-all text-xs text-muted-foreground" data-testid="status-folder">{sync.path}</span>
		<span class="mt-0.5 block text-xs text-muted-foreground">
			{#if sync.state === 'synced'}
				Epicenter keeps its history and syncs it.
			{:else}
				A Markdown note per recording beside its audio. Sync with Epicenter to keep their history and use them elsewhere.
			{/if}
		</span>
	</StatusRow>
	{#snippet footer()}
		<Button variant="outline" size="sm" disabled={sync.asking || whispering.recorder.phase !== 'idle'} onclick={() => sync.chooseDataFolder()}>Choose data folder…</Button>
	{/snippet}
</StatusPopover>
<FolderSyncActions {sync} />
