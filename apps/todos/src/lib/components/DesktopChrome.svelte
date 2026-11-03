<!--
	`#platform/chrome` in the desktop window: the header's account of its
	store, Todos' folder on this computer, whether Epicenter syncs it, Sync
	with Epicenter until it does, and Choose data folder… (decisions 81 and
	88), which reloads the page over the folder picked. It never signs in.
-->
<script lang="ts">
	import { folderSync } from '@epicenter/svelte/folder-sync';
	import FolderSyncActions from '@epicenter/svelte/folder-sync-actions';
	import StatusPopover from '@epicenter/svelte/status-popover';
	import StatusRow from '@epicenter/svelte/status-row';
	import type { StatusLine } from '@epicenter/svelte/status-line';
	import { Button } from '@epicenter/ui/button';
	import { appData, folder, todos } from '../app.tauri.js';
	import { CONTRACT_URL } from '../folder.tauri.js';

	let { pendingNewTodo }: { pendingNewTodo: boolean } = $props();

	const sync = folderSync({ appData, device: folder, contract: CONTRACT_URL });

	const status = $derived.by((): StatusLine => {
		const unreadable = todos.error;
		if (pendingNewTodo) return { label: 'Todo not added', tone: 'warning' };
		if (unreadable !== null) return { label: 'Not readable here', detail: unreadable.message, tone: 'error' };
		if (sync.synced) return { label: 'Synced by Epicenter', tone: 'good' };
		return { label: 'On this computer', tone: 'neutral' };
	});
</script>

<StatusPopover summary={status} details={[{ name: 'Status', testid: 'status-files', line: status }]}>
	<StatusRow name="Where">
		<span class="font-medium" data-testid="status-where">This computer</span>
		<span class="mt-0.5 block break-all text-xs text-muted-foreground">
			{sync.path}.
			{#if sync.synced}
				Epicenter syncs it to your repository.
			{:else}
				Sync with Epicenter to keep it in your repository too.
			{/if}
		</span>
	</StatusRow>
	{#snippet footer()}
		<Button variant="outline" size="sm" disabled={sync.asking} onclick={() => sync.chooseDataFolder()}>Choose data folder…</Button>
	{/snippet}
</StatusPopover>
<div class="ml-auto flex min-w-0 items-center gap-2">
	<FolderSyncActions {sync} />
</div>
