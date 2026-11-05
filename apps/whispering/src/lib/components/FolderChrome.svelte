<!--
	The header's account of the store when the folder is on this computer
	(`folder.reveal`): the data folder, whether Epicenter manages it, and Set
	up in Epicenter until it does. Whispering never syncs anything itself.
-->
<script lang="ts">
	import { APPS } from '@epicenter/definition/site';
	import { folderSync } from '@epicenter/svelte/folder-sync';
	import FolderSyncActions from '@epicenter/svelte/folder-sync-actions';
	import type { StatusLine } from '@epicenter/svelte/status-line';
	import StatusPopover from '@epicenter/svelte/status-popover';
	import StatusRow from '@epicenter/svelte/status-row';
	import { folder } from '../app.js';

	// `<WhenOpen>` renders the app, and so this, only over the open data folder.
	const sync = folderSync({ path: folder.displayPath() ?? '', site: APPS.WHISPERING.url });

	const status = $derived<StatusLine>(
		sync.managed ? { label: 'Kept by Epicenter', tone: 'good' } : { label: 'On this computer', tone: 'neutral' },
	);
</script>

<StatusPopover summary={status} details={[{ name: 'Files', testid: 'status-files', line: status }]}>
	<StatusRow name="Kept in">
		<span class="font-medium" data-testid="status-where">This computer</span>
		<span class="mt-0.5 block break-all text-xs text-muted-foreground" data-testid="status-folder">{sync.path}</span>
		<span class="mt-0.5 block text-xs text-muted-foreground">
			{#if sync.managed}
				Epicenter keeps its local history. Connect a repository there to use it on other devices.
			{:else}
				A Markdown note per recording beside its audio. Set up Epicenter to keep their history, then connect a repository to use them elsewhere.
			{/if}
		</span>
	</StatusRow>
</StatusPopover>
<FolderSyncActions {sync} />
