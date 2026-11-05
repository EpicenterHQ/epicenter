<script lang="ts">
	import { Separator } from '@epicenter/ui/separator';
	import { folder, shortcut, speech } from '$lib/app.js';
	import FolderSettings from '$lib/components/FolderSettings.svelte';
	import ShortcutSettings from '$lib/components/ShortcutSettings.svelte';
	import SpeechSettings from '$lib/components/SpeechSettings.svelte';
	import { connectionsNote } from '$lib/connections-note.js';
	import { getWhispering, type Operation } from '$lib/whispering.svelte.js';
	import AccountStatus from './AccountStatus.svelte';
	import ModelSetting from './ModelSetting.svelte';

	/**
	 * Settings: what this page's capabilities offer beyond the models (a
	 * folder on this computer, models that transcribe in this app's process,
	 * a global shortcut; each only where there is one), the sign-in, and the
	 * model this device uses for transcription and for text, with the
	 * connections and keys it reaches them through. Everything here stays on
	 * this device. `only` shows one model, as the control beside the
	 * recorder does.
	 */
	let { only }: { only?: Operation } = $props();

	const whispering = getWhispering();
	const operations = $derived<Operation[]>(only ? [only] : ['transcription', 'text']);
</script>

<div class="flex flex-col gap-4 text-sm">
	{#if !only}
		{#if folder.reveal !== null}<FolderSettings /><Separator />{/if}
		{#if speech}<SpeechSettings {speech} /><Separator />{/if}
		{#if shortcut}<ShortcutSettings {shortcut} /><Separator />{/if}
	{/if}
	<AccountStatus />
	{#if whispering.connectionsProblem}
		<p class="text-xs text-destructive" role="alert" data-testid="connections-problem">No saved connection is used: {whispering.connectionsProblem}</p>
	{/if}
	{#each operations as operation, index (operation)}
		{#if index > 0}<Separator />{/if}
		<ModelSetting {operation} />
	{/each}
	<p class="text-xs text-muted-foreground" data-testid="connections-note">{connectionsNote()}</p>
</div>
