<script lang="ts">
	import { Separator } from '@epicenter/ui/separator';
	import { createQuery } from '@tanstack/svelte-query';
	import { keysKept, query, shortcut, speech } from '$lib/app.js';
	import FolderSettings from './FolderSettings.svelte';
	import ShortcutSettings from './ShortcutSettings.svelte';
	import SpeechSettings from './SpeechSettings.svelte';
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

	/** Where a connection's key is kept and where its requests leave from, in the person's words. */
	const connectionsNote =
		keysKept === 'keychain'
			? "A connection's key is kept in this computer's Keychain, never in your folder. Whispering reads it when a request needs it and sends the request itself, so any endpoint works, including one on this computer or your network."
			: `A connection's key is kept in this browser's storage for this site, where code running on the site can read it, and never in your folder. Its requests leave this browser tab, so its endpoint must allow requests from ${location.origin} (CORS).`;
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
	<p class="text-xs text-muted-foreground" data-testid="connections-note">{connectionsNote}</p>
</div>
