<script lang="ts">
	import { liveSnapshot } from '@epicenter/svelte/snapshot';

	import { getFolder } from './folder.js';
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { createQuery } from '@tanstack/svelte-query';
	import { commands } from '../bindings.gen';
	import {
		type Connection,
		failureText,
		keyStateKey,
		KIND_LABELS,
		saveFailureText,
	} from './connections';

	/**
	 * One AI connection: its row in `so.epicenter`, whose title and model are
	 * edited in place through the folder's edit of the row
	 * (`folder.tables.connections.document(id)`): what is typed shows at
	 * once and saves a second after the last keystroke, even after the editor
	 * goes away. For an `openai-compatible` connection, the
	 * endpoint and key this computer keeps for it are in the keychain
	 * (ADR-0557). The page hands a key to the keychain and never reads one
	 * back. The list keys each editor by its id.
	 */
	let {
		row,
	}: {
		/** The row as the folder holds it now. */
		row: Connection;
	} = $props();
	const { folder, queryClient, getStatus } = getFolder();

	// svelte-ignore state_referenced_locally
	const id = row.id;
	// The list keys each editor by its id, in one opened folder. The list's
	// read answered the edit's document.
	const fileEdit = folder.tables.connections.document(id);
	const snapshot = liveSnapshot(fileEdit);
	/** The connection with what is typed over it, or as the list read it while that is not known. */
	const fields = $derived(snapshot.current.content?.issues === null ? snapshot.current.content.fields : row.fields);
	const failure = $derived(snapshot.current.saveError);

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
	let deleteProblem = $state<string>();
	let inputProblem = $state<string>();
	let savingKey = $state(false);

	function type(field: 'title' | 'model', text: string) {
		const { error } = fileEdit.patch({ fields: { [field]: text } });
		inputProblem = error?.message;
	}

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
		deleteProblem = undefined;
		// Closing Settings refuses the row's delete; the key stays with its row.
		if (getStatus().closing) return;
		const { error } = await commands.aiKeyRemove(id);
		if (error !== null) {
			keyProblem = `The key on this computer was not removed, so the connection was kept: ${failureText(error)}`;
			return;
		}
		const removed = await folder.files.delete(fileEdit.path);
		if (removed.error !== null) deleteProblem = saveFailureText(removed.error);
	}
</script>

<li class="grid gap-2 rounded-md border p-3">
	<div class="flex items-center justify-between gap-2">
		<p class="font-medium">{fields.title || id}</p>
		<span class="text-muted-foreground">{KIND_LABELS[fields.kind]} · {id}</span>
	</div>
	<div class="grid gap-2 sm:grid-cols-2">
		<label class="grid gap-1">
			<span class="text-muted-foreground">Title</span>
			<Input
				bind:value={() => fields.title, (value) => type('title', value)}

				aria-invalid={snapshot.current.saveError !== undefined || snapshot.current.loadError !== undefined}
			/>
		</label>
		<label class="grid gap-1">
			<span class="text-muted-foreground">Model</span>
			<Input
				bind:value={() => fields.model, (value) => type('model', value)}
				placeholder={fields.kind === 'local' ? 'The active local model' : 'whisper-large-v3'}

				aria-invalid={snapshot.current.saveError !== undefined || snapshot.current.loadError !== undefined}
			/>
		</label>
	</div>
	{#if inputProblem}<p role="alert" class="text-sm text-destructive">{inputProblem}</p>{/if}
	{#if snapshot.current.loadError}
		<p role="alert" class="text-sm text-destructive">{snapshot.current.loadError.message}</p>
	{/if}
	{#if failure !== undefined}
		<p role="alert" class="text-destructive">
			Not saved: {saveFailureText(failure)}
			<button type="button" class="underline" onclick={() => void fileEdit.save()}>Try again</button>
		</p>
	{/if}

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
	{#if deleteProblem}<p role="alert" class="text-destructive">{deleteProblem}</p>{/if}
	<div>
		<Button variant="ghost" size="sm"  onclick={() => void removeConnection()}>Delete connection</Button>
	</div>
</li>
