<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Separator } from '@epicenter/ui/separator';
	import type { Operation } from '$lib/connections.js';
	import { getWhispering } from '$lib/whispering.svelte.js';
	import ConnectionForm from './ConnectionForm.svelte';

	/**
	 * Settings: this device's two connections. Everything here stays on this
	 * device. `only` shows one connection, as the control beside the recorder
	 * does.
	 */
	let { only }: { only?: Operation } = $props();

	const { library } = getWhispering();
	const operations = $derived<Operation[]>(only ? [only] : ['transcription', 'text']);
</script>

<div class="flex flex-col gap-4 text-sm">
	{#if library.connectionsProblem}
		<div class="flex flex-col gap-2 text-xs text-destructive" role="alert" data-testid="connections-problem">
			<p>The connections on this device could not be read, so none is used: {library.connectionsProblem}</p>
			<Button size="xs" variant="outline" class="self-start" onclick={() => void library.readConnections()}>Read again</Button>
		</div>
	{/if}
	{#each operations as operation, index (operation)}
		{#if index > 0}<Separator />{/if}
		<ConnectionForm {operation} />
	{/each}
</div>
