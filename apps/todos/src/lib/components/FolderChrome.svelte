<!--
	When the folder is on this computer (`folder.reveal`): the header's account
	of its store, Todos' folder on this computer, whether Epicenter syncs it,
	and where to get Epicenter until it does. A desktop app never syncs
	(ADR-0822).
-->
<script lang="ts">
	import { folderSync } from '@epicenter/svelte/folder-sync';
	import FolderSyncActions from '@epicenter/svelte/folder-sync-actions';
	import FolderOnboarding from '@epicenter/svelte/folder-onboarding';
	import StatusPopover from '@epicenter/svelte/status-popover';
	import StatusRow from '@epicenter/svelte/status-row';
	import type { StatusLine } from '@epicenter/svelte/status-line';
	import { folder } from '../app.js';

	let {
		pendingNewTodo,
	}: {
		/** Whether a typed new todo is still waiting for Add. */
		pendingNewTodo: boolean;
	} = $props();

	/** Why the folder's store cannot be reached now, if it cannot. */
	const unavailable = $derived(folder.unavailable());

	// `<WhenOpen>` renders the pages, and so this, only over the open folder.
	const sync = folderSync({ path: folder.displayPath() ?? '' });

	const status = $derived.by((): StatusLine => {
		if (pendingNewTodo) return { label: 'Todo not added', tone: 'warning' };
		if (unavailable !== null) return { label: 'Not reachable', detail: unavailable.message, tone: 'error' };
		if (sync.synced) return { label: 'Synced by Epicenter', tone: 'good' };
		return { label: 'On this computer', tone: 'neutral' };
	});
</script>

<StatusPopover summary={status} details={[{ name: 'Status', testid: 'status-files', line: status }]}>
	<StatusRow name="Where">
		<span class="font-medium" data-testid="status-where">This computer</span>
		<FolderOnboarding noun="todos" path={sync.path} />
		<span class="mt-0.5 block text-xs text-muted-foreground">
			{#if sync.synced}
				Epicenter keeps it in sync across your devices.
			{:else}
				On this computer only. Epicenter syncs it across your devices.
			{/if}
		</span>
	</StatusRow>
</StatusPopover>
<div class="ml-auto flex min-w-0 items-center gap-2">
	<FolderSyncActions {sync} />
</div>
