<!--
	Settings only the desktop app has: the folder Whispering keeps its files
	in (show it, choose another, sync it with Epicenter), the models that
	transcribe on this computer, and the global shortcut.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Separator } from '@epicenter/ui/separator';
	import { toast } from '@epicenter/ui/sonner';
	import LocalModelAdministration from '@epicenter/transcription-native/local-model-administration';
	import { whenSaved } from '@epicenter/svelte/leave-guard';
	import { onMount } from 'svelte';
	import { desktop } from '#platform/desktop';
	import { SHORTCUT_LABEL } from '$lib/platform/shell.tauri.js';
	import { getWhispering } from '$lib/whispering.svelte.js';
	import { getDesktop } from './context.js';
	import { createSyncState } from './sync-state.svelte.js';

	const whispering = getWhispering();
	const { folder } = getDesktop();
	const sync = createSyncState(folder);
	let moving = $state(false);

	onMount(() => void sync.check());

	async function chooseFolder() {
		if (desktop === null) return;
		if (whispering.recorder.phase !== 'idle') {
			toast.error('Finish recording before choosing another folder.');
			return;
		}
		moving = true;
		// Nothing in flight is left behind: the next window opens the new folder.
		await whenSaved();
		const { error } = await desktop.folder.choose();
		moving = false;
		if (error !== null) toast.error('Whispering did not move', { description: error });
	}
</script>

<section class="flex flex-col gap-2 text-xs" data-testid="desktop-folder">
	<p class="text-sm font-medium">Folder</p>
	<p class="break-all text-muted-foreground" data-testid="desktop-folder-path">{folder}</p>
	<p class="text-muted-foreground">
		Plain files: a Markdown note per recording beside its audio. Whispering never syncs them;
		{#if sync.state === 'synced'}Epicenter syncs this folder.{:else}Epicenter can, when you ask it to.{/if}
	</p>
	<div class="flex flex-wrap gap-2">
		<Button size="xs" variant="outline" disabled={moving} onclick={() => void chooseFolder()} data-testid="choose-folder">Choose folder…</Button>
		{#if sync.state === 'not-synced'}
			<Button size="xs" variant="outline" disabled={sync.asking} onclick={() => void sync.request()}>Sync with Epicenter</Button>
		{/if}
	</div>
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
