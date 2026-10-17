<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { useQueryClient } from '@tanstack/svelte-query';
	import { type AiConnection, type AiConnectionChange, commands } from '../bindings.gen';
	import DebouncedText from './DebouncedText.svelte';
	import { CONNECTIONS_KEY, failureText, KIND_LABELS } from './connections';

	/**
	 * One AI connection on this computer: its title and model, edited in
	 * place, each change saved through `ai_key_set` (ADR-0576, ADR-0587), and,
	 * for an `openai-compatible` connection, the endpoint and key this
	 * computer keeps for it in the keychain (ADR-0557). The page hands a key
	 * to the keychain and never reads one back. The list keys each editor by
	 * the connection's id.
	 */
	let { connection }: { connection: AiConnection } = $props();

	// svelte-ignore state_referenced_locally
	const id = connection.id;
	const client = useQueryClient();

	let endpoint = $state('');
	let key = $state('');
	let problem = $state<string>();
	let saving = $state(false);

	/** Save `edit` to this connection; rejects with why it was not saved. */
	async function save(edit: AiConnectionChange) {
		try {
			const { error } = await commands.aiKeySet(id, edit);
			if (error !== null) throw new Error(failureText(error));
		} finally {
			await client.invalidateQueries({ queryKey: CONNECTIONS_KEY });
		}
	}

	async function saveKey() {
		saving = true;
		problem = undefined;
		try {
			await save({ endpoint, key });
			key = '';
			endpoint = '';
		} catch (cause) {
			problem = cause instanceof Error ? cause.message : String(cause);
		} finally {
			saving = false;
		}
	}

	async function remove() {
		problem = undefined;
		const { error } = await commands.aiKeyRemove(id);
		if (error !== null) problem = `The connection was kept: ${failureText(error)}`;
		await client.invalidateQueries({ queryKey: CONNECTIONS_KEY });
	}
</script>

<li class="grid gap-2 rounded-md border p-3">
	<div class="flex items-center justify-between gap-2">
		<p class="font-medium">{connection.title || id}</p>
		<span class="text-muted-foreground">{KIND_LABELS[connection.kind]} · {id}</span>
	</div>
	<div class="grid gap-2 sm:grid-cols-2">
		<DebouncedText label="Title" value={connection.title} save={(text) => save({ title: text })} />
		<DebouncedText
			label="Model"
			value={connection.model}
			placeholder={connection.kind === 'local' ? 'The active local model' : 'whisper-large-v3'}
			save={(text) => save({ model: text })}
		/>
	</div>

	{#if connection.kind === 'openai-compatible'}
		{#if connection.key?.state === 'saved'}
			<p>
				Sends to {connection.key.endpoint}{connection.key.hasKey ? ' with the key saved on this computer.' : ' with no key.'}
			</p>
		{:else if connection.key?.state === 'unreadable'}
			<p role="alert" class="text-destructive">{connection.key.message}</p>
		{:else}
			<p>Key missing. Add your endpoint and key on this computer.</p>
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
			<Button type="submit" disabled={saving}>Save key</Button>
		</form>
		<p class="text-muted-foreground">
			The endpoint and key stay in this computer's keychain, and a key is sent only to the endpoint it was saved for.
		</p>
	{:else if connection.kind === 'epicenter'}
		<p>Sends to your Epicenter account with this app's sign-in, under Account above.</p>
	{:else}
		<p class="text-muted-foreground">Runs on this computer with the local transcription model chosen below. Nothing is sent.</p>
	{/if}
	{#if problem}<p role="alert" class="text-destructive">{problem}</p>{/if}
	<div>
		<Button variant="ghost" size="sm" onclick={() => void remove()}>Delete connection</Button>
	</div>
</li>
