<script lang="ts">
	import { ConnectionList } from '@epicenter/ai/ui';
	import { Button } from '@epicenter/ui/button';
	import { Label } from '@epicenter/ui/label';
	import { Separator } from '@epicenter/ui/separator';
	import { toast } from '@epicenter/ui/sonner';
	import { type Operation, unusable } from '$lib/connection-routes.js';
	import { getSession } from '$lib/session.svelte.js';

	/**
	 * Settings: which connection each operation uses, and the connections
	 * themselves, rows of this device's `so.epicenter` (ADR-0557) edited with
	 * the same editor as Epicenter's Settings. `only` shows one operation's
	 * choice, as the control beside the recorder does.
	 */
	let { only }: { only?: Operation } = $props();

	const { library, workspace } = getSession();
	const operations = $derived<Operation[]>(only ? [only] : ['transcription', 'text']);
	const LABELS: Record<Operation, { title: string; detail: string }> = {
		transcription: { title: 'Transcription', detail: 'Audio is sent only when you press Transcribe.' },
		text: {
			title: 'Text',
			detail: 'Transformations send their instructions and text only when you press Run. A transformation may name its own model.',
		},
	};

	async function choose(operation: Operation, connection: string) {
		const problem = await library.chooseConnection(operation, connection || undefined);
		if (problem) toast.error(`Could not choose the ${operation} connection`, { description: problem });
	}
</script>

<div class="flex flex-col gap-4 text-sm">
	{#if library.connectionsProblem}
		<div class="flex flex-col gap-2 text-xs text-destructive" role="alert" data-testid="connections-problem">
			<p>The connections on this device could not be read, so none is used: {library.connectionsProblem}</p>
			<Button size="xs" variant="outline" class="self-start" onclick={() => void library.openConnections()}>Try again</Button>
		</div>
	{/if}
	{#each operations as operation (operation)}
		{@const chosen = library.connections[operation]}
		<div class="flex flex-col gap-1.5" data-testid="{operation}-choice">
			<Label for="{operation}-connection">{LABELS[operation].title}</Label>
			<select
				id="{operation}-connection"
				class="h-8 rounded-md border border-input bg-transparent px-2 text-sm dark:bg-input/30"
				value={chosen?.connection ?? ''}
				onchange={(event) => void choose(operation, event.currentTarget.value)}
			>
				<option value="">None</option>
				{#each library.connectionRows as row (row.stem)}
					{@const why = unusable({ workspace }, operation, row.kind, row.title || row.stem)}
					<option value={row.stem} disabled={why !== undefined}>
						{row.title || row.stem}{row.model ? ` · ${row.model}` : ''}{why ? ' (not here)' : ''}
					</option>
				{/each}
				{#if chosen && chosen.kind === undefined}
					<option value={chosen.connection} disabled>A connection that is gone</option>
				{/if}
			</select>
			<p class="text-xs text-muted-foreground">{LABELS[operation].detail}</p>
			{#if chosen?.unusable}
				<p class="text-xs text-destructive" role="alert">{chosen.unusable}</p>
			{/if}
		</div>
	{/each}
	{#if !only}
		<Separator />
		<div class="flex flex-col gap-2">
			<p class="font-medium">Connections</p>
			<p class="text-xs text-muted-foreground">{workspace.connections.note}</p>
			{#if library.connectionTable}
				<ConnectionList
					options={library.connectionTable}
					keys={workspace.connections.keys}
					kinds={workspace.connections.kinds}
					epicenterNote={workspace.connections.epicenterNote}
				/>
			{/if}
		</div>
	{/if}
	{#if library.settingsProblem}
		<p class="text-xs text-destructive" role="alert">kv.json: {library.settingsProblem}</p>
	{/if}
</div>
