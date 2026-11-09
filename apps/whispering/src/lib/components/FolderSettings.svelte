<!--
	The data folder Whispering keeps its recordings in, where the folder is
	on this computer (`folder.reveal`): where it is, and whether Epicenter
	syncs it (ADR-0822).
-->
<script lang="ts">
	import { folderSync } from '@epicenter/svelte/folder-sync';
	import FolderSyncActions from '@epicenter/svelte/folder-sync-actions';
	import FolderOnboarding from '@epicenter/svelte/folder-onboarding';
	import { folder } from '../app.js';

	// `<WhenOpen>` renders the app, and so this, only over the open data folder.
	const sync = folderSync({ path: folder.displayPath() ?? '' });
</script>

<section class="flex flex-col gap-2 text-xs" data-testid="desktop-folder">
	<p class="text-sm font-medium">Data folder</p>
	<FolderOnboarding noun="recordings" path={sync.path} pathTestId="desktop-folder-path" />
	<p class="text-muted-foreground">
		Plain files: a Markdown note per recording beside its audio. Whispering never syncs them;
		{#if sync.synced}Epicenter keeps this folder in sync across your devices.{:else}Epicenter, once installed, syncs it across your devices.{/if}
	</p>
	<div class="flex flex-wrap items-center gap-2">
		<FolderSyncActions {sync} />
	</div>
</section>
