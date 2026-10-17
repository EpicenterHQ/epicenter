<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { useQueryClient } from '@tanstack/svelte-query';
	import { type AiConnection, type AiConnectionKind, commands } from '../bindings.gen';
	import ConnectionEditor from './ConnectionEditor.svelte';
	import { CONNECTIONS_KEY, connectionId, failureText, KIND_LABELS, OFFERED_KINDS } from './connections';

	/**
	 * Every AI connection on this computer, each with its editor, and a form
	 * that adds one: its entry, then, for an endpoint, its endpoint and key in
	 * this computer's keychain, in one `ai_key_set`.
	 */
	let { connections }: { connections: AiConnection[] } = $props();

	const client = useQueryClient();
	const sorted = $derived(
		[...connections].sort((a, b) => (a.title || a.id).localeCompare(b.title || b.id)),
	);

	let kind = $state<AiConnectionKind>('openai-compatible');
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
			const id = connectionId(title, new Set(connections.map((connection) => connection.id)));
			const { error } = await commands.aiKeySet(id, {
				kind,
				title,
				model,
				...(kind === 'openai-compatible' && { endpoint, key }),
			});
			if (error !== null) {
				problem = failureText(error);
				return;
			}
			title = '';
			model = '';
			endpoint = '';
			key = '';
		} finally {
			adding = false;
			await client.invalidateQueries({ queryKey: CONNECTIONS_KEY });
		}
	}
</script>

{#if sorted.length === 0}
	<p class="text-muted-foreground">No AI connections on this computer yet. They stay on this computer, so each computer you use sets up its own.</p>
{/if}
<ul class="grid gap-2">
	{#each sorted as connection (connection.id)}
		<ConnectionEditor {connection} />
	{/each}
</ul>

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
