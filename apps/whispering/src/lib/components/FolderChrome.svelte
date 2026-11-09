<!--
	The header's account of the store when the folder is on this computer
	(`folder.reveal`): the data folder, whether Epicenter syncs it, and
	where to get Epicenter until it does. Whispering never syncs anything
	itself (ADR-0822).
-->
<script lang="ts">
	import { folderSync } from '@epicenter/svelte/folder-sync';
	import FolderSyncActions from '@epicenter/svelte/folder-sync-actions';
	import type { StatusLine } from '@epicenter/svelte/status-line';
	import StatusPopover from '@epicenter/svelte/status-popover';
	import StatusRow from '@epicenter/svelte/status-row';
	import { folder } from '../app.js';

	// `<WhenOpen>` renders the app, and so this, only over the open data folder.
	const sync = folderSync({ path: folder.displayPath() ?? '' });

	const status = $derived<StatusLine>(
		sync.synced ? { label: 'Synced by Epicenter', tone: 'good' } : { label: 'On this computer', tone: 'neutral' },
	);
</script>

<StatusPopover summary={status} details={[{ name: 'Files', testid: 'status-files', line: status }]}>
	<StatusRow name="Kept in">
		<span class="font-medium" data-testid="status-where">This computer</span>
		<span class="mt-0.5 block break-all text-xs text-muted-foreground" data-testid="status-folder">{sync.path}</span>
		<span class="mt-0.5 block text-xs text-muted-foreground">
			{#if sync.synced}
				Epicenter keeps it in sync across your devices.
			{:else}
				A Markdown note per recording beside its audio. Epicenter syncs them across your devices.
			{/if}
		</span>
	</StatusRow>
</StatusPopover>
<FolderSyncActions {sync} />
