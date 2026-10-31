<!--
	Settings only the desktop app has: the data folder Whispering keeps its
	recordings in (where it is, Choose data folder…, Sync with Epicenter),
	the models that transcribe on this computer, and the global shortcut.
-->
<script lang="ts">
	import { getFolderSync } from '@epicenter/svelte/folder-sync';
	import FolderSyncActions from '@epicenter/svelte/folder-sync-actions';
	import LocalModelAdministration from '@epicenter/transcription-native/local-model-administration';
	import { Button } from '@epicenter/ui/button';
	import { Separator } from '@epicenter/ui/separator';
	import { SHORTCUT_LABEL } from '../platform/shortcut.tauri.js';
	import { getWhispering } from '../whispering.svelte.js';

	const sync = getFolderSync();
	const whispering = getWhispering();
	/** Choosing reloads the window over the folder picked, which would end a recording. */
	const recording = $derived(whispering.recorder.phase !== 'idle');
</script>

<section class="flex flex-col gap-2 text-xs" data-testid="desktop-folder">
	<p class="text-sm font-medium">Data folder</p>
	<p class="break-all text-muted-foreground" data-testid="desktop-folder-path">{sync.path ?? ''}</p>
	<p class="text-muted-foreground">
		Plain files: a Markdown note per recording beside its audio. Whispering never syncs them;
		{#if sync.state === 'synced'}Epicenter syncs this folder.{:else}Epicenter can, when you ask it to.{/if}
	</p>
	<div class="flex flex-wrap items-center gap-2">
		<Button size="sm" variant="outline" disabled={sync.asking || recording} onclick={() => sync.chooseDataFolder()} data-testid="choose-data-folder">Choose data folder…</Button>
		<FolderSyncActions {sync} />
	</div>
	{#if recording}<p class="text-muted-foreground">Finish recording before choosing another folder.</p>{/if}
</section>
<Separator />
<section class="flex flex-col gap-2 text-xs" data-testid="desktop-models">
	<p class="text-sm font-medium">On this computer</p>
	<p class="text-muted-foreground">
		Transcribe without sending audio anywhere: download a model, make it active, then choose “Use this computer” for transcription.
	</p>
	<LocalModelAdministration />
</section>
<Separator />
<section class="flex flex-col gap-1 text-xs">
	<p class="text-sm font-medium">Shortcut</p>
	<p class="text-muted-foreground"><kbd class="rounded border px-1">{SHORTCUT_LABEL}</kbd> starts and stops a recording from any app.</p>
</section>
