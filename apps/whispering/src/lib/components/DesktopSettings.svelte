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
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { Input } from '@epicenter/ui/input';
	import { Label } from '@epicenter/ui/label';
	import { Separator } from '@epicenter/ui/separator';
	import { getGlobalShortcut } from '../platform/shortcut.tauri.svelte.js';
	import { getWhispering } from '../whispering.svelte.js';

	const sync = getFolderSync();
	const whispering = getWhispering();
	const shortcut = getGlobalShortcut();
	/** Choosing reloads the window over the folder picked, which would end a recording. */
	const recording = $derived(whispering.recorder.phase !== 'idle');

	/** What the person typed and has not saved; none shows the shortcut as resolved. */
	let typed = $state<string>();
	/** Where the person chose to save it; none follows where the shortcut is set now. */
	let here = $state<boolean>();
	let saving = $state(false);
	/** Why the last save did not land. */
	let unsaved = $state<string | null>(null);

	async function save(event: SubmitEvent) {
		event.preventDefault();
		saving = true;
		unsaved = await shortcut.save(typed ?? shortcut.accelerator, {
			onThisComputer: here ?? shortcut.onThisComputer,
		});
		saving = false;
		if (unsaved === null) {
			typed = undefined;
			here = undefined;
		}
	}
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
<section class="flex flex-col gap-2 text-xs" data-testid="desktop-shortcut">
	<p class="text-sm font-medium">Shortcut</p>
	<p class="text-muted-foreground">
		<kbd class="rounded border px-1" data-testid="shortcut-label">{shortcut.label}</kbd> starts and stops a recording from any app.
	</p>
	<form class="flex flex-col gap-2" onsubmit={save}>
		<Label for="global-shortcut" class="font-normal">Keys, as modifiers and a key joined by +</Label>
		<div class="flex items-center gap-2">
			<Input
				id="global-shortcut"
				class="h-8 font-mono text-xs"
				placeholder="CommandOrControl+Shift+;"
				spellcheck={false}
				autocomplete="off"
				disabled={!shortcut.read || saving}
				bind:value={() => typed ?? shortcut.accelerator, (value) => (typed = value)}
				data-testid="shortcut-input"
			/>
			<Button size="sm" variant="outline" type="submit" disabled={!shortcut.read || saving} data-testid="shortcut-save">Save</Button>
		</div>
		<div class="flex items-center gap-2">
			<Checkbox
				id="shortcut-this-computer"
				bind:checked={() => here ?? shortcut.onThisComputer, (checked) => (here = checked)}
				disabled={!shortcut.read || saving}
				data-testid="shortcut-this-computer"
			/>
			<Label for="shortcut-this-computer" class="font-normal">Only on this computer</Label>
		</div>
	</form>
	<p class="text-muted-foreground">
		Kept in <code>shortcuts.md</code>: the data folder's goes wherever your files go;
		“Only on this computer” keeps it in this computer's settings instead, ahead of the data folder's.
	</p>
	{#if unsaved ?? shortcut.problem}
		<p class="text-destructive" role="alert" data-testid="shortcut-problem">{unsaved ?? shortcut.problem}</p>
	{/if}
</section>
