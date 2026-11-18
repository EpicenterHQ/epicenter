<script lang="ts">
	import { Separator } from '@epicenter/ui/separator';
	import { settings, shortcut, speech } from '$lib/app.js';
	import FolderSettings from '$lib/components/FolderSettings.svelte';
	import ShortcutSettings from '$lib/components/ShortcutSettings.svelte';
	import SpeechSettings from '$lib/components/SpeechSettings.svelte';
	import { connectionsNote } from '$lib/connections-note.js';
	import type { Operation } from '$lib/whispering.svelte.js';
	import ModelSetting from './ModelSetting.svelte';

	/**
	 * Settings: where the recordings are kept, what this page's capabilities
	 * offer beyond the models (models that transcribe in this app's process,
	 * a global shortcut; each only where there is one), and the model used
	 * for transcription and for text, with the connections it reaches them
	 * through. The choices, connections and shortcut are `settings.md` in
	 * the folder; keys stay on this computer. `only` shows one model, as the
	 * control beside the recorder does.
	 */
	let { only }: { only?: Operation } = $props();

	const operations = $derived<Operation[]>(only ? [only] : ['transcription', 'text']);
</script>

<div class="flex flex-col gap-4 text-sm">
	{#if !only}
		<FolderSettings /><Separator />
		{#if speech}<SpeechSettings {speech} /><Separator />{/if}
		{#if shortcut}<ShortcutSettings {shortcut} /><Separator />{/if}
	{/if}
	{#if settings.problem()}
		<p class="text-xs text-destructive" role="alert" data-testid="settings-problem">
			settings.md does not read ({settings.problem()}), so no model or connection in it is used. Choosing a model or saving a connection replaces it.
		</p>
	{/if}
	{#each operations as operation, index (operation)}
		{#if index > 0}<Separator />{/if}
		<ModelSetting {operation} />
	{/each}
	<p class="text-xs text-muted-foreground" data-testid="connections-note">{connectionsNote()}</p>
</div>
