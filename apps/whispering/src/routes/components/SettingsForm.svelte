<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Separator } from '@epicenter/ui/separator';
	import { onMount } from 'svelte';
	import { Settings } from '#platform/root';
	import { variant } from '#platform/variant';
	import type { Operation } from '$lib/connections.js';
	import { evictionNote, readPersisted } from '$lib/eviction-note.js';
	import { getLibrary } from '$lib/library.svelte.js';
	import { getWhispering } from '$lib/whispering.svelte.js';
	import ConnectionForm from './ConnectionForm.svelte';
	import AccountStatus from './AccountStatus.svelte';

	/**
	 * Settings: what only this build has (`Settings` from `#platform/root`:
	 * on the desktop, the data folder and the models on this computer), the
	 * optional sign-in, and this device's two connections. Everything here
	 * stays on this device. `only` shows one connection, as the control
	 * beside the recorder does. Under the sign-in, which says where the
	 * recordings stay, Safari on the web adds that it may clear them
	 * (`evictionNote`).
	 */
	let { only }: { only?: Operation } = $props();

	const whispering = getWhispering();
	const library = getLibrary();
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
			storageWorks: library.error === null,
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
		<div class="flex flex-col gap-2 text-xs text-destructive" role="alert" data-testid="connections-problem">
			<p>The connections on this device could not be read, so none is used: {whispering.connectionsProblem}</p>
			<Button size="xs" variant="outline" class="self-start" onclick={() => void whispering.readConnections()}>Read again</Button>
		</div>
	{/if}
	{#each operations as operation, index (operation)}
		{#if index > 0}<Separator />{/if}
		<ConnectionForm {operation} />
	{/each}
</div>
