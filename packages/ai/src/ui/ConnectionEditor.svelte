<script lang="ts">
	import type { StoredRow } from '@epicenter/folder';
	import type { TableOptions } from '@epicenter/folder/query';
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { onDestroy } from 'svelte';
	import type { ConnectionKind } from '../send.js';
	import DebouncedText from './DebouncedText.svelte';
	import { type ConnectionFields, type ConnectionKeys, keyStateKey, KIND_LABELS } from './connection-keys.js';

	/**
	 * One AI connection: its row in `so.epicenter`, whose title and model are
	 * edited in place, each change setting its field on the file as it is now
	 * (ADR-0576), and, for an `openai-compatible` connection, the endpoint and
	 * key `keys` keeps for it: this computer's keychain (ADR-0557) or this
	 * browser's storage (ADR-0581). The page hands a key over and never reads
	 * one back. The list keys each editor by its stem.
	 */
	let {
		stored,
		options,
		keys,
		epicenterNote,
	}: {
		stored: StoredRow<ConnectionFields> & { stem: string };
		options: TableOptions<ConnectionFields>;
		keys: ConnectionKeys;
		epicenterNote: string;
	} = $props();
	const here = $derived(keys.place === 'computer' ? 'this computer' : 'this browser');

	// svelte-ignore state_referenced_locally
	const stem = stored.stem;
	const fields = $derived(stored.row.fields);
	const client = useQueryClient();
	const setConnection = createMutation(() => options.set.mutationOptions());
	const deleteConnection = createMutation(() => options.delete.mutationOptions());

	const keyState = createQuery(() => ({
		queryKey: keyStateKey(stem),
		enabled: fields.kind === 'openai-compatible',
		queryFn: async () => {
			const { data, error } = await keys.state(stem);
			if (error !== null) throw new Error(error);
			return data;
		},
	}));
	// A key saved or removed in another tab shows here too. `keys` is fixed
	// for the editor's life.
	// svelte-ignore state_referenced_locally
	onDestroy(
		keys.onChange?.((connection) => {
			if (connection === stem) void client.invalidateQueries({ queryKey: keyStateKey(stem) });
		}) ?? (() => {}),
	);

	let endpoint = $state('');
	let key = $state('');
	let keyProblem = $state<string>();
	let savingKey = $state(false);

	async function save(field: 'title' | 'model', text: string) {
		await setConnection.mutateAsync({ stem, fields: { [field]: text.trim() } });
	}

	async function saveKey() {
		savingKey = true;
		keyProblem = undefined;
		try {
			const { error } = await keys.save(stem, endpoint, key);
			if (error !== null) keyProblem = error;
			else {
				key = '';
				endpoint = '';
			}
		} finally {
			savingKey = false;
			await client.invalidateQueries({ queryKey: keyStateKey(stem) });
		}
	}

	async function removeKey() {
		keyProblem = undefined;
		const { error } = await keys.remove(stem);
		if (error !== null) keyProblem = error;
		await client.invalidateQueries({ queryKey: keyStateKey(stem) });
	}

	async function removeConnection() {
		keyProblem = undefined;
		const { error } = await keys.remove(stem);
		if (error !== null) {
			keyProblem = `The key in ${here} was not removed, so the connection was kept: ${error}`;
			return;
		}
		deleteConnection.mutate(stem);
	}
</script>

<li class="grid gap-2 rounded-md border p-3">
	<div class="flex items-center justify-between gap-2">
		<p class="font-medium">{fields.title || stem}</p>
		<span class="text-muted-foreground">{KIND_LABELS[fields.kind as ConnectionKind]} · {stem}</span>
	</div>
	<div class="grid gap-2 sm:grid-cols-2">
		<DebouncedText label="Title" value={fields.title} save={(text) => save('title', text)} />
		<DebouncedText
			label="Model"
			value={fields.model}
			placeholder={fields.kind === 'local' ? 'The active local model' : 'whisper-large-v3'}
			save={(text) => save('model', text)}
		/>
	</div>
	{#if setConnection.error}<p role="alert" class="text-destructive">{setConnection.error.message}</p>{/if}

	{#if fields.kind === 'openai-compatible'}
		{#if keyState.isPending}
			<p class="text-muted-foreground">Reading the key in {here}…</p>
		{:else if keyState.error}
			<p role="alert" class="text-destructive">{keyState.error.message}</p>
		{:else if keyState.data?.state === 'saved'}
			<p>
				Sends to {keyState.data.endpoint}{keyState.data.hasKey ? ` with the key saved in ${here}.` : ' with no key.'}
			</p>
		{:else}
			<p>Add your key in {here}.</p>
		{/if}
		<form
			class="grid gap-2 sm:grid-cols-[1fr_1fr_auto]"
			onsubmit={(event) => {
				event.preventDefault();
				void saveKey();
			}}
		>
			<Input bind:value={endpoint} placeholder="https://api.openai.com/v1" aria-label="Endpoint" required />
			<Input bind:value={key} type="password" placeholder="Key, or empty for none" aria-label="Key" autocomplete="off" />
			<Button type="submit" disabled={savingKey}>Save key</Button>
		</form>
		<p class="text-muted-foreground">
			{keys.place === 'computer'
				? "The endpoint and key stay in this computer's keychain."
				: 'The endpoint and key are saved in this browser. Code running on this site can read them.'}
			They are not written to the folder, and a key is sent only to the endpoint it was saved for.
		</p>
		{#if keyState.data?.state === 'saved'}
			<div><Button variant="outline" size="sm" onclick={() => void removeKey()}>Remove key</Button></div>
		{/if}
	{:else if fields.kind === 'epicenter'}
		<p>{epicenterNote}</p>
	{:else}
		<p class="text-muted-foreground">Runs on this computer with the local transcription model chosen below. Nothing is sent.</p>
	{/if}
	{#if keyProblem}<p role="alert" class="text-destructive">{keyProblem}</p>{/if}
	{#if deleteConnection.error}<p role="alert" class="text-destructive">{deleteConnection.error.message}</p>{/if}
	<div>
		<Button variant="ghost" size="sm" onclick={() => void removeConnection()}>Delete connection</Button>
	</div>
</li>
