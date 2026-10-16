<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { Label } from '@epicenter/ui/label';
	import { Separator } from '@epicenter/ui/separator';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import type { Operation } from '$lib/connections.js';
	import { getSession } from '$lib/session.svelte.js';
	import ConnectionForm from './ConnectionForm.svelte';

	/**
	 * Settings: this device's two connections, and the key an earlier version
	 * saved, if any. Everything here stays on this device. `only` shows one
	 * connection, as the control beside the recorder does.
	 */
	let { only }: { only?: Operation } = $props();

	const { library, settings } = getSession();
	const operations = $derived<Operation[]>(only ? [only] : ['transcription', 'text']);

	/** Where the earlier key may go: only destinations the person ticks, as each form shows them now. */
	let chosen = $state<Operation[]>([]);
	const offered = $derived(
		operations.filter((operation) => settings[operation].readOnlyReason === undefined),
	);

	async function adopt() {
		const problem = await settings.adoptLegacyKey(chosen.filter((operation) => offered.includes(operation)));
		if (problem) toast.error(problem.title, { description: problem.description });
		else {
			chosen = [];
			toast.success('The earlier key is saved with the connections you chose');
		}
	}
</script>

<div class="flex flex-col gap-4 text-sm">
	{#if library.connectionsProblem}
		<div class="flex flex-col gap-2 text-xs text-destructive" role="alert" data-testid="connections-problem">
			<p>The connections on this device could not be read, so none is used: {library.connectionsProblem}</p>
			<Button size="xs" variant="outline" class="self-start" onclick={() => void library.readConnections()}>Read again</Button>
		</div>
	{/if}
	{#if library.connections?.legacyKey && offered.length > 0}
		<div class="flex flex-col gap-2 rounded border p-2 text-xs" data-testid="legacy-key">
			<p>
				A key saved by an earlier version of Whispering is on this device. It is not sent anywhere until you choose where
				it may go. Choosing moves it there; it is never shown.
			</p>
			{#each offered as operation (operation)}
				{@const target = settings[operation]}
				<div class="flex items-center gap-2">
					<Checkbox
						id="legacy-key-{operation}"
						checked={chosen.includes(operation)}
						onCheckedChange={(checked) =>
							(chosen = checked ? [...chosen, operation] : chosen.filter((item) => item !== operation))}
						data-testid="legacy-key-{operation}"
					/>
					<Label for="legacy-key-{operation}" class="min-w-0 font-normal break-all">
						{operation === 'transcription' ? 'Transcription' : 'Text'} at {target.baseUrl}
					</Label>
				</div>
			{/each}
			<Button size="xs" class="self-start" disabled={chosen.length === 0 || settings.adopting} onclick={adopt} data-testid="legacy-key-adopt">
				{#if settings.adopting}<Spinner class="size-3" />{/if}
				Use the earlier key there
			</Button>
		</div>
	{/if}
	{#each operations as operation, index (operation)}
		{#if index > 0}<Separator />{/if}
		<ConnectionForm {operation} />
	{/each}
</div>
