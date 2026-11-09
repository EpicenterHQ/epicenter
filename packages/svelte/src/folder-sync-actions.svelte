<!--
	A desktop app's header note for its folder (ADR-0822): the app never syncs,
	so until Epicenter syncs the folder it says where to get Epicenter.
-->
<script lang="ts">
	import { GET_EPICENTER, type FolderSyncState } from './folder-sync.svelte.js';

	let { sync }: { sync: FolderSyncState } = $props();
</script>

{#if !sync.synced}
	<p class="min-w-0 truncate text-xs text-muted-foreground" title="Epicenter syncs this folder across your devices">
		Get Epicenter to sync: <span class="select-all font-medium">{GET_EPICENTER.replace('https://', '')}</span>
	</p>
{/if}
