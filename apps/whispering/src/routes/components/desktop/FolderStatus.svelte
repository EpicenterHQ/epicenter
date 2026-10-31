<!--
	The desktop header's account of the folder, where the browser shows its
	two views: the folder's name, whether Epicenter syncs it, and "Sync with
	Epicenter" until it does (decision 81). Whispering never syncs anything
	itself.
-->
<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import { onMount } from 'svelte';
	import { getDesktop } from './context.js';
	import { createSyncState } from './sync-state.svelte.js';

	const { folder } = getDesktop();
	const sync = createSyncState(folder);
	const name = folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder;

	onMount(() => void sync.check());
</script>

<svelte:window onfocus={() => void sync.check()} />

<div class="flex min-w-0 items-center gap-1.5 text-xs" data-testid="folder-status">
	<span class="flex min-w-0 items-center gap-1 text-muted-foreground" title={folder}>
		<FolderIcon class="size-3.5 shrink-0" />
		<span class="truncate" data-testid="folder-name">{name}</span>
	</span>
	{#if sync.state === 'synced'}
		<Badge variant="secondary" class="shrink-0" data-testid="folder-synced">
			<RefreshCwIcon class="size-3" />Synced by Epicenter
		</Badge>
	{:else if sync.state === 'not-synced'}
		<Button size="xs" variant="outline" class="shrink-0" disabled={sync.asking} onclick={() => void sync.request()} data-testid="sync-with-epicenter">
			Sync with Epicenter
		</Button>
	{/if}
</div>
