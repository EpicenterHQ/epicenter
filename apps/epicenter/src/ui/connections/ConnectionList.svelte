<script lang="ts">
	import type { ConnectionKind } from '@epicenter/ai/send';
	import type { TableOptions, TableWrites } from '@epicenter/folder/query';
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { createMutation, createQuery } from '@tanstack/svelte-query';
	import { resultMutationOptions } from 'wellcrafted/query';
	import type { Row } from '@epicenter/folder';
	import { commands } from '../bindings.gen';
	import ConnectionEditor from './ConnectionEditor.svelte';
	import { type ConnectionFields, connectionId, failureText, KIND_LABELS, OFFERED_KINDS } from './connections';

	/**
	 * Every AI connection in `so.epicenter`, each with its editor, and a form
	 * that adds one: its row, then, for an endpoint, its endpoint and key in
	 * this computer's keychain.
	 */
	let {
		options,
		writes,
	}: { options: TableOptions<ConnectionFields>; writes: TableWrites<ConnectionFields> } = $props();

	const list = createQuery(() => options.list.queryOptions());
	const create = createMutation(() =>
		resultMutationOptions({
			mutationKey: ['connections', 'create'],
			mutationFn: ({ stem, row }: { stem: string; row: Row<ConnectionFields> }) =>
				writes.create(row, { stem }),
		}),
	);

	const rows = $derived(
		(list.data ?? [])
			.flatMap(({ stem, result }) => (result.error === null ? [{ ...result.data, stem }] : []))
			.sort((a, b) => a.row.fields.title.localeCompare(b.row.fields.title)),
	);
	const unreadable = $derived((list.data ?? []).filter(({ result }) => result.error !== null));

	let kind = $state<ConnectionKind>('openai-compatible');
	let title = $state('');
	let model = $state('');
	let endpoint = $state('');
	let key = $state('');
	let problem = $state<string>();
	let adding = $state(false);

	async function add() {
		adding = true;
		problem = undefined;
		try {
			const stem = connectionId(title, new Set((list.data ?? []).map((item) => item.stem)));
			const saved = await create
				.mutateAsync({ stem, row: { fields: { kind, title: title.trim(), model: model.trim() }, body: '' } })
				.then(
					() => true,
					(cause: unknown) => {
						problem = cause instanceof Error ? cause.message : String(cause);
						return false;
					},
				);
			if (!saved) return;
			if (kind === 'openai-compatible') {
				const { error } = await commands.aiKeySet(stem, endpoint, key);
				if (error !== null) {
					problem = `The connection was added, but its endpoint and key were not saved on this computer: ${failureText(error)}`;
					return;
				}
			}
			title = '';
			model = '';
			endpoint = '';
			key = '';
		} finally {
			adding = false;
		}
	}
</script>

{#if list.error}
	<p role="alert" class="text-destructive">Could not list the connections: {list.error.message}</p>
{:else if list.isPending}
	<p class="text-muted-foreground">Reading…</p>
{:else}
	{#if rows.length === 0}
		<p class="text-muted-foreground">No AI connections yet. Each one is a file in so.epicenter/connections, so it follows you to every computer where that folder syncs.</p>
	{/if}
	<ul class="grid gap-2">
		{#each rows as stored (stored.stem)}
			<ConnectionEditor {stored} {writes} />
		{/each}
	</ul>
	{#each unreadable as { stem, result } (stem)}
		<p role="alert" class="text-destructive">connections/{stem}.md does not read: {result.error?.message}</p>
	{/each}
{/if}

<form
	class="grid gap-2 rounded-md border border-dashed p-3"
	onsubmit={(event) => {
		event.preventDefault();
		void add();
	}}
>
	<p class="font-medium">Add a connection</p>
	<div class="grid gap-2 sm:grid-cols-3">
		<select
			bind:value={kind}
			aria-label="Kind"
			class="h-9 rounded-md border border-input bg-transparent px-2 dark:bg-input/30"
		>
			{#each OFFERED_KINDS as option (option)}
				<option value={option}>{KIND_LABELS[option]}</option>
			{/each}
		</select>
		<Input bind:value={title} placeholder="Title, such as Groq" aria-label="Title" required />
		<Input bind:value={model} placeholder="Model" aria-label="Model" />
	</div>
	{#if kind === 'openai-compatible'}
		<div class="grid gap-2 sm:grid-cols-2">
			<Input bind:value={endpoint} placeholder="https://api.openai.com/v1" aria-label="Endpoint" required />
			<Input bind:value={key} type="password" placeholder="Key, or empty for none" aria-label="Key" autocomplete="off" />
		</div>
	{:else if kind === 'epicenter'}
		<p class="text-muted-foreground">Sends to your Epicenter account with this app's sign-in, under Account above.</p>
	{/if}
	<div><Button type="submit" disabled={adding}>Add</Button></div>
	{#if problem}<p role="alert" class="text-destructive">{problem}</p>{/if}
</form>
