<script lang="ts">
	import type { ConnectionKind } from '@epicenter/ai/send';
	import { type getFolder, setFolder } from './folder.js';
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { createQuery, setQueryClientContext } from '@tanstack/svelte-query';
	import { commands } from '../bindings.gen';
	import ConnectionEditor from './ConnectionEditor.svelte';
	import {
		connectionId,
		connectionsOf,
		failureText,
		KIND_LABELS,
		OFFERED_KINDS,
		saveFailureText,
		unreadableOf,
	} from './connections';

	/**
	 * Every AI connection in `so.epicenter`, each with its editor, a file that
	 * does not read as one shown as it is, and a form that adds one: its row,
	 * then, for an endpoint, its endpoint and key in this computer's keychain.
	 */
	let { context }: { context: ReturnType<typeof getFolder> } = $props();
	// Settings keeps this opened folder until the list unmounts.
	// svelte-ignore state_referenced_locally
	const { folder, queries, queryClient, refresh, getStatus } = setFolder(context);
	setQueryClientContext(queryClient);

	const list = createQuery(() => queries.rows('connections'));
	const rows = $derived(connectionsOf(list.data ?? []));
	const unreadable = $derived(unreadableOf(list.data ?? []));

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
			const id = connectionId(title, new Set((list.data ?? []).map((row) => row.id)));
			const { error } = await folder.tables.connections.set(id, {
				fields: { kind, title: title.trim(), model: model.trim() },
				body: '',
			});
			if (error !== null) {
				problem = saveFailureText(error);
				return;
			}
			await refresh([`connections/${id}.md`]);
			if (kind === 'openai-compatible') {
				const { error } = await commands.aiKeySet(id, endpoint, key);
				if (error !== null) {
					problem = `The connection was added, but its endpoint and key were not saved on this computer: ${failureText(error)}`;
					return;
				}
			}
			title = '';
			model = '';
			endpoint = '';
			key = '';
		} catch (cause) {
			problem = cause instanceof Error ? cause.message : String(cause);
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
		{#each rows as row (row.id)}
			<ConnectionEditor {row} />
		{/each}
	</ul>
	{#each unreadable as row (row.id)}
		<div role="alert" class="grid gap-1 text-destructive">
			<p>connections/{row.id}.md does not read as a connection: {row.issues.map((issue) => issue.message).join(' ')}</p>
			{#if row.text !== ''}
				<pre class="max-h-32 overflow-auto rounded-md border p-2 font-mono text-xs whitespace-pre-wrap text-foreground">{row.text}</pre>
			{/if}
		</div>
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
	<div><Button type="submit" disabled={adding || getStatus().closing}>Add</Button></div>
	{#if problem}<p role="alert" class="text-destructive">{problem}</p>{/if}
</form>
