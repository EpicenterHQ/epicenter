<!--
	The data folder Whispering keeps its recordings in, where the folder is
	on this computer (`folder.reveal`): where it is, and Set up in Epicenter.
-->
<script lang="ts">
	import { APPS } from '@epicenter/definition/site';
	import { folderSync } from '@epicenter/svelte/folder-sync';
	import FolderSyncActions from '@epicenter/svelte/folder-sync-actions';
	import FolderOnboarding from '@epicenter/svelte/folder-onboarding';
	import { folder } from '../app.js';

	// `<WhenOpen>` renders the app, and so this, only over the open data folder.
	const sync = folderSync({ path: folder.displayPath() ?? '', site: APPS.WHISPERING.url });
</script>

<section class="flex flex-col gap-2 text-xs" data-testid="desktop-folder">
	<p class="text-sm font-medium">Data folder</p>
	<FolderOnboarding noun="recordings" path={sync.path} pathTestId="desktop-folder-path" />
	<p class="text-muted-foreground">
		Plain files: a Markdown note per recording beside its audio. Whispering never syncs them;
		{#if sync.managed}Epicenter keeps this folder's local history.{:else}Epicenter can keep its history when you ask it to.{/if}
	</p>
	<div class="flex flex-wrap items-center gap-2">
		<FolderSyncActions {sync} />
	</div>
</section>
