<script lang="ts">
	import type { epicenterDefinition } from '@epicenter/ai/connection-table';
	import { browserKeys, ConnectionList } from '@epicenter/ai/ui';
	import type { FolderOptions } from '@epicenter/folder/query';
	import { Button } from '@epicenter/ui/button';
	import { createQuery } from '@tanstack/svelte-query';

	/**
	 * Which connection the tutor uses (ADR-0581): Epicenter's hosted model when
	 * signed in, or one of this browser's connections, each naming one model.
	 * "Connections" opens the same editor Epicenter's Settings uses, over this
	 * browser's `so.epicenter`.
	 */
	let {
		connections,
		choice,
		signedIn,
		hostedLabel,
		disabled = false,
		onChoose,
	}: {
		connections: FolderOptions<typeof epicenterDefinition> | null;
		/** The stored `tutorConnection`; undefined is the hosted default. */
		choice: string | undefined;
		signedIn: boolean;
		hostedLabel: string;
		disabled?: boolean;
		onChoose: (connection: string | undefined) => void;
	} = $props();

	const keys = browserKeys();
	const list = createQuery(() => ({
		...connections!.tables.connections.list.queryOptions(),
		enabled: connections !== null,
	}));
	const rows = $derived(
		(list.data ?? [])
			.flatMap(({ stem, result }) => (result.error === null ? [{ stem, ...result.data.row.fields }] : []))
			.filter((row) => row.kind !== 'local')
			.sort((a, b) => (a.title || a.stem).localeCompare(b.title || b.stem)),
	);
	let managing = $state(false);
</script>

<div class="flex flex-wrap items-center gap-2">
	<select
		class="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-sm dark:bg-input/30"
		aria-label="Tutor connection"
		{disabled}
		value={choice ?? ''}
		onchange={(event) => onChoose(event.currentTarget.value || undefined)}
	>
		{#if signedIn}
			<option value="">{hostedLabel}</option>
		{:else if !choice}
			<option value="" disabled>Choose a connection</option>
		{/if}
		{#each rows as row (row.stem)}
			<option value={row.stem}>{row.title || row.stem}{row.model ? ` · ${row.model}` : ''}</option>
		{/each}
		{#if choice && !rows.some((row) => row.stem === choice)}
			<option value={choice} disabled>A connection that is gone</option>
		{/if}
	</select>
	{#if connections}
		<Button variant="outline" size="sm" onclick={() => (managing = !managing)}>
			{managing ? 'Done' : 'Connections'}
		</Button>
	{/if}
</div>
{#if managing && connections}
	<div class="mt-2 grid max-h-96 gap-2 overflow-y-auto rounded-md border p-3 text-sm">
		<ConnectionList
			options={connections.tables.connections}
			{keys}
			kinds={signedIn ? ['openai-compatible', 'epicenter'] : ['openai-compatible']}
			epicenterNote="Sends to your Epicenter account with your sign-in."
		/>
	</div>
{/if}
