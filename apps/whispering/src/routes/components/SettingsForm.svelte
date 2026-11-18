<script lang="ts">
	import { Separator } from '@epicenter/ui/separator';
	import { createQuery } from '@tanstack/svelte-query';
	import { query, shortcut, speech } from '$lib/app.js';
	import FolderSettings from './settings/FolderSettings.svelte';
	import ShortcutSettings from './settings/ShortcutSettings.svelte';
	import SpeechSettings from './settings/SpeechSettings.svelte';
	import { connectionsNote } from '$lib/connections-note.js';
	import ModelSetting from './ModelSetting.svelte';

	/**
	 * Settings: where the recordings are kept, what this page's capabilities
	 * offer beyond the models (models that transcribe in this app's process,
	 * a global shortcut; each only where there is one), and the model used
	 * for transcription, with the connections it reaches it through. The choices, connections and shortcut are `settings.md` in
	 * the folder; keys stay on this computer. `modelOnly` shows the model
	 * alone, as the control beside the recorder does.
	 */
	let { modelOnly = false }: { modelOnly?: boolean } = $props();

	/** `settings.md` as its query last read it. */
	const settings = createQuery(() => query.settingsQueries.get());
	const problem = $derived(settings.data?.problem);
</script>

<div class="flex flex-col gap-4 text-sm">
	{#if !modelOnly}
		<FolderSettings /><Separator />
		{#if speech}<SpeechSettings {speech} /><Separator />{/if}
		{#if shortcut}<ShortcutSettings {shortcut} /><Separator />{/if}
	{/if}
	{#if problem}
		<p class="text-xs text-destructive" role="alert" data-testid="settings-problem">
			settings.md does not read ({problem}), so no model or connection in it is used. Choosing a model or saving a connection replaces it.
		</p>
	{/if}
	<ModelSetting />
	<p class="text-xs text-muted-foreground" data-testid="connections-note">{connectionsNote()}</p>
</div>
