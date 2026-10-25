<script lang="ts">
	import { draft, type SvelteFolder } from '@epicenter/svelte/folder-next';
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { commands } from '../bindings.gen';
	import {
		type Connection,
		connectionTables,
		failureText,
		keyStateKey,
		KIND_LABELS,
	} from './connections';

	/**
	 * One AI connection: its row in `so.epicenter`, whose title and model are
	 * edited in place through the folder's row update. For an `openai-compatible` connection, the
	 * endpoint and key this computer keeps for it are in the keychain
	 * (ADR-0557). The page hands a key to the keychain and never reads one
	 * back. The list keys each editor by its id.
	 */
	let { folder, row }: {
		folder: SvelteFolder<typeof connectionTables>;
		/** The row as the folder holds it now. */
		row: Connection;
	} = $props();
	const queryClient = useQueryClient();

	// svelte-ignore state_referenced_locally
	const id = row.id;
	const fields = $derived(row.fields);
	const title = draft(() => row.fields.title, (value) => folder.tables.connections.update(id, { fields: { title: value } }));
	const model = draft(() => row.fields.model, (value) => folder.tables.connections.update(id, { fields: { model: value } }));

	const keyState = createQuery(() => ({
		queryKey: keyStateKey(id),
		enabled: fields.kind === 'openai-compatible',
		// The keychain changes outside the folder, so read it again as before.
		staleTime: 0,
		refetchOnWindowFocus: true,
		queryFn: async () => {
			const { data, error } = await commands.aiKeyState(id);
			if (error !== null) throw new Error(failureText(error));
			return data;
		},
	}));

	let endpoint = $state('');
	let key = $state('');
	let keyProblem = $state<string>();
	let savingKey = $state(false);

	async function saveKey() {
		savingKey = true;
		keyProblem = undefined;
		try {
			const { error } = await commands.aiKeySet(id, endpoint, key);
			if (error !== null) keyProblem = failureText(error);
			else {
				key = '';
				endpoint = '';
			}
		} finally {
			savingKey = false;
			await queryClient.invalidateQueries({ queryKey: keyStateKey(id) });
		}
	}

	async function removeKey() {
		keyProblem = undefined;
		const { error } = await commands.aiKeyRemove(id);
		if (error !== null) keyProblem = failureText(error);
		await queryClient.invalidateQueries({ queryKey: keyStateKey(id) });
	}

	async function removeConnection() {
		keyProblem = undefined;
		const { error } = await commands.aiKeyRemove(id);
		if (error !== null) {
			keyProblem = `The key on this computer was not removed, so the connection was kept: ${failureText(error)}`;
			return;
		}
		await folder.tables.connections.delete(id);
	}
</script>

<li class="grid gap-2 rounded-md border p-3">
	<div class="flex items-center justify-between gap-2">
		<p class="font-medium">{title.text || id}</p>
		<span class="text-muted-foreground">{KIND_LABELS[fields.kind]} · {id}</span>
	</div>
	<div class="grid gap-2 sm:grid-cols-2">
		<label class="grid gap-1">
			<span class="text-muted-foreground">Title</span>
			<Input
				bind:value={title.text}
			/>
		</label>
		<label class="grid gap-1">
			<span class="text-muted-foreground">Model</span>
			<Input
				bind:value={model.text}
				placeholder={fields.kind === 'local' ? 'The active local model' : 'whisper-large-v3'}
			/>
		</label>
	</div>

	{#if fields.kind === 'openai-compatible'}
		{#if keyState.isPending}
			<p class="text-muted-foreground">Reading this computer's key…</p>
		{:else if keyState.error}
			<p role="alert" class="text-destructive">{keyState.error.message}</p>
		{:else if keyState.data?.state === 'saved'}
			<p>
				Sends to {keyState.data.endpoint}{keyState.data.hasKey ? ' with the key saved on this computer.' : ' with no key.'}
			</p>
		{:else}
			<p>Add your key on this computer.</p>
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
			The endpoint and key stay in this computer's keychain. They are not written to the folder, and a key is sent only to the endpoint it was saved for.
		</p>
		{#if keyState.data?.state === 'saved'}
			<div><Button variant="outline" size="sm" onclick={() => void removeKey()}>Remove key</Button></div>
		{/if}
	{:else if fields.kind === 'epicenter'}
		<p>Sends to your Epicenter account with this app's sign-in, under Account above.</p>
	{:else}
		<p class="text-muted-foreground">Runs on this computer with the local transcription model chosen below. Nothing is sent.</p>
	{/if}
	{#if keyProblem}<p role="alert" class="text-destructive">{keyProblem}</p>{/if}
	<div>
		<Button variant="ghost" size="sm"  onclick={() => void removeConnection()}>Delete connection</Button>
	</div>
</li>
