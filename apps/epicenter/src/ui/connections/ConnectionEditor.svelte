<script lang="ts">
	import type { ConnectionKind } from '@epicenter/ai/send';
	import type { StoredRow } from '@epicenter/folder';
	import type { TableOptions } from '@epicenter/folder/query';
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { commands } from '../bindings.gen';
	import DebouncedText from './DebouncedText.svelte';
	import { type ConnectionFields, failureText, keyStateKey, KIND_LABELS } from './connections';

	/**
	 * One AI connection: its row in `so.epicenter`, whose title and model are
	 * edited in place, each change an update of the file as it is now
	 * (ADR-0554), and, for an `openai-compatible` connection, the endpoint and
	 * key this computer keeps for it in the keychain (ADR-0557). The page
	 * hands a key to the keychain and never reads one back. The list keys
	 * each editor by its stem.
	 */
	let {
		stored,
		options,
	}: {
		stored: StoredRow<ConnectionFields> & { stem: string };
		options: TableOptions<ConnectionFields>;
	} = $props();

	// svelte-ignore state_referenced_locally
	const stem = stored.stem;
	const fields = $derived(stored.row.fields);
	const client = useQueryClient();
	const update = createMutation(() => options.update.mutationOptions());
	const remove = createMutation(() => options.delete.mutationOptions());

	const keyState = createQuery(() => ({
		queryKey: keyStateKey(stem),
		enabled: fields.kind === 'openai-compatible',
		queryFn: async () => {
			const { data, error } = await commands.aiKeyState(stem);
			if (error !== null) throw new Error(failureText(error));
			return data;
		},
	}));

	let endpoint = $state('');
	let key = $state('');
	let keyProblem = $state<string>();
	let savingKey = $state(false);

	async function save(field: 'title' | 'model', text: string) {
		await update.mutateAsync({ stem, set: { [field]: text.trim() } });
	}

	async function saveKey() {
		savingKey = true;
		keyProblem = undefined;
		try {
			const { error } = await commands.aiKeySet(stem, endpoint, key);
			if (error !== null) keyProblem = failureText(error);
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
		const { error } = await commands.aiKeyRemove(stem);
		if (error !== null) keyProblem = failureText(error);
		await client.invalidateQueries({ queryKey: keyStateKey(stem) });
	}

	async function removeConnection() {
		keyProblem = undefined;
		const { error } = await commands.aiKeyRemove(stem);
		if (error !== null) {
			keyProblem = `The key on this computer was not removed, so the connection was kept: ${failureText(error)}`;
			return;
		}
		remove.mutate(stored);
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
	{#if update.error}<p role="alert" class="text-destructive">{update.error.message}</p>{/if}

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
	{#if remove.error}<p role="alert" class="text-destructive">{remove.error.message}</p>{/if}
	<div>
		<Button variant="ghost" size="sm" onclick={() => void removeConnection()}>Delete connection</Button>
	</div>
</li>
