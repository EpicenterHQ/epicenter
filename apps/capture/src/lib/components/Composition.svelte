<!-- The same capture file before Add: its body is raw, unfinished Markdown. -->
<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Field from '@epicenter/ui/field';
	import { Textarea } from '@epicenter/ui/textarea';
	import { toast } from '@epicenter/ui/sonner';
	import { createMutation } from '@tanstack/svelte-query';
	import { onDestroy } from 'svelte';
	import { resultMutationOptions } from 'wellcrafted/query';
	import { type CaptureEdit } from '$lib/capture-form.svelte.js';
	import { type Captures, describeFailure } from '$lib/captures.svelte.js';
	import { copyText } from '$lib/download.js';
	import { confirmDelete } from '$lib/item-actions.js';

	let { captures, stem, rowEdit, onAdded }: {
		captures: Captures;
		stem: string;
		rowEdit: CaptureEdit;
		onAdded: () => void;
	} = $props();

	const add = createMutation(() => resultMutationOptions({
		mutationKey: ['captures', 'add', stem],
		mutationFn: () => captures.add(stem),
		onSuccess: () => { onAdded(); },
	}));
	let mounted = true;
	let refusal = $state<string>();
	onDestroy(() => { mounted = false; });

	async function copy(text: string) {
		if (await copyText(text)) toast.success('Your text copied');
		else toast.error('Could not copy. Select the text and copy it.');
	}
</script>

{#if rowEdit.row?.issues === null && rowEdit.row.fields.draft === true}
	{@const row = rowEdit.row}
	<div class="flex flex-col gap-4">
		<div class="flex flex-wrap items-center gap-3">
			<Button variant="outline" size="sm" onclick={() => captures.leave()}>Back to timeline</Button>
			<h1 class="mr-auto text-lg font-semibold tracking-tight">Draft capture</h1>
			<Button variant="ghost" size="sm" disabled={rowEdit.locked} onclick={() => confirmDelete(captures, stem)}>Discard draft…</Button>
		</div>
		<p class="text-sm text-muted-foreground">Your writing saves on this device. Find it under Drafts when you return.</p>
		{#if rowEdit.pending?.error}
			<Alert.Root variant="destructive" aria-label="Not saved">
				<Alert.Title>Your draft is not saved</Alert.Title>
				<Alert.Description>{describeFailure(rowEdit.pending.error)} Your text is still here.</Alert.Description>
				<div class="mt-2 flex flex-wrap gap-2 text-foreground">
					<Button variant="outline" size="sm" disabled={rowEdit.locked} onclick={() => void rowEdit.retry()}>Save again</Button>
					<Button variant="outline" size="sm" onclick={() => copy(row.body)}>Copy your text</Button>
				</div>
			</Alert.Root>
		{/if}
		{#if add.error}
			<Alert.Root variant="destructive" role="alert">
				<Alert.Title>The capture was not added</Alert.Title>
				<Alert.Description>{describeFailure(add.error)} Your draft is still here.</Alert.Description>
			</Alert.Root>
		{/if}
		<form class="flex flex-col gap-4" onsubmit={(event) => {
			event.preventDefault();
			if (mounted && !rowEdit.locked && rowEdit.row?.fields.draft === true) add.mutate();
		}}>
			<Field.Field>
				<Field.Label for="new-capture">Capture text</Field.Label>
				<Textarea
					id="new-capture"
					readonly={rowEdit.locked}
					aria-invalid={refusal !== undefined}
					bind:value={
						() => row.body.replace(/\r\n?/g, '\n'),
						(typed) => {
							// Promotion can finish before Svelte removes this control.
							if (rowEdit.row?.issues !== null || rowEdit.row.fields.draft !== true) return;
							const body = row.body.includes('\r\n') ? typed.replace(/\r?\n/g, '\r\n') : typed;
							const { error } = rowEdit.change({ body: body.toWellFormed() });
							refusal = error?.message;
							if (error !== null) return;
							add.reset();
						}
					}
					onblur={() => void rowEdit.save()}
					onkeydown={(event) => {
						if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
							event.preventDefault();
							event.currentTarget.form?.requestSubmit();
						}
					}}
					rows={8}
					class="max-h-96 min-h-48"
					placeholder="Write or paste something…"
				/>
				{#if refusal}<Field.Error>{refusal} Your previous text is kept.</Field.Error>{/if}
				<Field.Description>Add capture finishes the composition and adds its Thoughts section. Ctrl or ⌘ + Enter adds it.</Field.Description>
			</Field.Field>
			<div class="flex justify-end">
				<Button type="submit" disabled={rowEdit.locked || add.isPending || row.body.trim() === ''}>{add.isPending ? 'Adding…' : 'Add capture'}</Button>
			</div>
		</form>
	</div>
{/if}
