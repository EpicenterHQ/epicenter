<!--
	A desktop app's header actions for its folder: the last request's answer,
	and "Sync with Epicenter" until Epicenter syncs the folder.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import type { FolderSyncState } from './folder-sync.svelte.js';

	let { sync }: { sync: FolderSyncState } = $props();
</script>

{#if sync.request !== undefined}
	<p
		role="status"
		class={['min-w-0 truncate text-xs', sync.request.tone === 'failed' ? 'text-destructive' : 'text-muted-foreground']}
		title={sync.request.message}
	>
		{sync.request.message}
	</p>
{/if}
{#if sync.state !== 'synced'}
	<Button variant="outline" size="sm" disabled={sync.asking} onclick={() => sync.syncWithEpicenter()}>Sync with Epicenter</Button>
{/if}
