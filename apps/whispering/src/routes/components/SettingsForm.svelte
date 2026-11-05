<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Separator } from '@epicenter/ui/separator';
	import { onMount } from 'svelte';
	import { Settings } from '#platform/components';
	import { connectionsNote, variant } from '#platform/variant';
	import { evictionNote, readPersisted } from '$lib/eviction-note.js';
	import { folder } from '$lib/app.js';
	import { getWhispering, type Operation } from '$lib/whispering.svelte.js';
	import AccountStatus from './AccountStatus.svelte';
	import ModelSetting from './ModelSetting.svelte';

	/**
	 * Settings: what only this build has (`Settings` from `#platform/components`:
	 * on the desktop, the data folder and the models on this computer), the
	 * optional sign-in, and the model this device uses for transcription and
	 * for text, with the connections and keys it reaches them through.
	 * Everything here stays on this device. `only` shows one model, as the
	 * control beside the recorder does. Under the sign-in, which says where the
	 * recordings stay, Safari on the web adds that it may clear them
	 * (`evictionNote`).
	 */
	let { only }: { only?: Operation } = $props();

	const whispering = getWhispering();
	let persisted = $state<boolean>();
	onMount(() => {
		let current = true;
		void readPersisted().then((answer) => {
			if (current) persisted = answer;
		});
		return () => {
			current = false;
		};
	});
	const note = $derived(
		evictionNote({
			variant,
			vendor: navigator.vendor,
			storageWorks: folder.unavailable() === null,
			persisted,
		}),
	);
	const operations = $derived<Operation[]>(only ? [only] : ['transcription', 'text']);
</script>

<div class="flex flex-col gap-4 text-sm">
	{#if Settings && !only}
		<Settings />
		<Separator />
	{/if}
	<AccountStatus />
	{#if note && !only}
		<p class="text-xs text-muted-foreground" data-testid="eviction-note">{note}</p>
	{/if}
	{#if whispering.connectionsProblem}
		<p class="text-xs text-destructive" role="alert" data-testid="connections-problem">No saved connection is used: {whispering.connectionsProblem}</p>
	{/if}
	{#each operations as operation, index (operation)}
		{#if index > 0}<Separator />{/if}
		<ModelSetting {operation} />
	{/each}
	<p class="text-xs text-muted-foreground" data-testid="connections-note">{connectionsNote()}</p>
</div>
