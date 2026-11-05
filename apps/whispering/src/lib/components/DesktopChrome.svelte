<!--
	The desktop window's header account of its store: the data folder on
	this computer, whether Epicenter manages it, Set up in Epicenter until it
	does. Whispering never syncs anything itself. The global shortcut's
	presses are heard here too: a press starts a recording, or stops the one
	under way, from any app, as the header's button does.
-->
<script lang="ts">
	import { APPS } from '@epicenter/definition/site';
	import { folderSync } from '@epicenter/svelte/folder-sync';
	import FolderSyncActions from '@epicenter/svelte/folder-sync-actions';
	import type { StatusLine } from '@epicenter/svelte/status-line';
	import StatusPopover from '@epicenter/svelte/status-popover';
	import StatusRow from '@epicenter/svelte/status-row';
	import { onMount } from 'svelte';
	import { folder } from '../app.js';
	import { onShortcut } from '../platform/shortcut.tauri.js';
	import { getWhispering } from '../whispering.svelte.js';

	// `<WhenOpen>` renders the app, and so this, only over the open data folder.
	const sync = folderSync({ path: folder.displayPath() ?? '', site: APPS.WHISPERING.url });
	const whispering = getWhispering();

	const status = $derived<StatusLine>(
		sync.managed ? { label: 'Kept by Epicenter', tone: 'good' } : { label: 'On this computer', tone: 'neutral' },
	);

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
			{#if sync.managed}
				Epicenter keeps its local history. Connect a repository there to use it on other devices.
			{:else}
				A Markdown note per recording beside its audio. Set up Epicenter to keep their history, then connect a repository to use them elsewhere.
			{/if}
		</span>
	</StatusRow>
</StatusPopover>
<FolderSyncActions {sync} />
