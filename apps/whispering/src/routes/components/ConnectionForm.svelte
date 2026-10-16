<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { Label } from '@epicenter/ui/label';
	import * as RadioGroup from '@epicenter/ui/radio-group';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import type { KeyAction } from '$lib/settings-draft.svelte.js';
	import { getSession } from '$lib/session.svelte.js';

	/**
	 * One connection: where its requests go, the model used when a request
	 * names none, and its key. It edits the session's draft, so every place
	 * this form is shown has the same typing and one save. Saving keeps
	 * everything on this device and sends nothing: the model is whatever the
	 * person types, and the endpoint is never asked anything.
	 */
	let { operation }: { operation: 'transcription' | 'text' } = $props();

	const { library, settings } = getSession();
	const draft = $derived(settings[operation]);
	const readOnly = $derived(draft.readOnlyReason !== undefined);
	const id = $derived(`connection-${operation}`);

	const copy = {
		transcription: {
			title: 'Transcription',
			sends: 'Audio is sent here only when you press Transcribe.',
			model: 'Your provider’s transcription model name.',
		},
		text: {
			title: 'Text',
			sends:
				'Transformations send their instructions and text here only when you press Run. A transformation may name its own model.',
			model: 'The chat model used when a transformation names none.',
		},
	} as const;

	async function save(event: SubmitEvent) {
		event.preventDefault();
		const problem = await draft.save();
		if (problem) toast.error(problem.title, { description: problem.description });
		else toast.success(`${copy[operation].title} connection saved`);
	}
</script>

<form class="flex flex-col gap-3 text-sm" onsubmit={save} data-testid={id}>
	<p class="font-medium">{copy[operation].title}</p>
	<p class="text-xs text-muted-foreground" data-testid="{id}-status">
		{#if draft.saved}
			Set up: {draft.saved.baseUrl} · {draft.saved.model || 'no default model'} · {draft.saved.keyPresent ? 'with a key' : 'no key'}.
		{:else}
			Not set up. Nothing is sent until you save it.
		{/if}
		{copy[operation].sends}
	</p>
	{#if draft.readOnlyReason}
		<p class="text-xs text-muted-foreground">{draft.readOnlyReason}</p>
	{/if}
	{#if operation === 'transcription' && !draft.saved && library.earlierTranscription.baseUrl}
		<p class="text-xs text-muted-foreground" data-testid="earlier-transcription">
			This folder’s kv.json names {library.earlierTranscription.baseUrl}{library.earlierTranscription.model ? ` and ${library.earlierTranscription.model}` : ''}, saved by an earlier
			version. They fill in the form; nothing is sent there until you save.
		</p>
	{/if}
	<label class="flex flex-col gap-1">
		<span class="text-xs text-muted-foreground">API endpoint</span>
		<Input bind:value={draft.baseUrl} autocomplete="off" spellcheck={false} disabled={readOnly} data-testid="{id}-base-url" />
		<span class="text-xs text-muted-foreground">An OpenAI-compatible base URL, such as https://api.openai.com/v1.</span>
	</label>
	<label class="flex flex-col gap-1">
		<span class="text-xs text-muted-foreground">Model</span>
		<Input bind:value={draft.model} autocomplete="off" spellcheck={false} disabled={readOnly} data-testid="{id}-model" />
		<span class="text-xs text-muted-foreground">{copy[operation].model}</span>
	</label>
	{#if !readOnly}
		<div class="flex flex-col gap-1">
			<span class="text-xs text-muted-foreground">API key</span>
			{#if draft.saved?.keyPresent}
				<RadioGroup.Root
					value={draft.keyAction}
					onValueChange={(next) => (draft.keyAction = next as KeyAction)}
					class="gap-1.5"
					aria-label="{copy[operation].title} key"
				>
					{#each [['keep', 'Keep the saved key'], ['replace', 'Use a new key'], ['remove', 'Remove the key']] as const as [value, label] (value)}
						<div class="flex items-center gap-2">
							<RadioGroup.Item {value} id="{id}-key-{value}" />
							<Label for="{id}-key-{value}" class="font-normal">{label}</Label>
						</div>
					{/each}
				</RadioGroup.Root>
			{/if}
			{#if !draft.saved?.keyPresent || draft.keyAction === 'replace'}
				<Input
					type="password"
					bind:value={draft.key}
					placeholder={draft.saved?.keyPresent ? 'The new key' : 'Optional for a local endpoint'}
					autocomplete="off"
					data-testid="{id}-key"
				/>
			{/if}
			<span class="text-xs text-muted-foreground">
				Kept in {library.workspace.connections.storedIn}. It is sent only to this endpoint; a new endpoint needs its key entered again.
			</span>
			{#if library.workspace.kind === 'browser'}
				<span class="text-xs text-warning" data-testid="{id}-key-warning">
					This key is saved in this browser. Code running on this site can read it.
				</span>
			{/if}
		</div>
	{/if}
	{#if draft.problem && !readOnly}
		<p class="text-xs text-warning" role="status" data-testid="{id}-problem">{draft.problem}</p>
	{/if}
	{#if !readOnly}
		<Button type="submit" size="sm" disabled={draft.saving || draft.problem !== undefined} data-testid="{id}-save">
			{#if draft.saving}<Spinner class="size-3.5" />{/if}
			Save {copy[operation].title.toLowerCase()} connection
		</Button>
	{/if}
</form>
