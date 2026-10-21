<!--
	New capture: the text typed here is this form's until Add writes it as a
	finished capture, which then opens at Add a thought. Nothing is written
	before Add, and leaving the timeline clears it. A failed Add keeps it.
-->
<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Field from '@epicenter/ui/field';
	import { Textarea } from '@epicenter/ui/textarea';
	import { type Captures, describeFailure, type Failure } from '$lib/captures.svelte.js';

	let { captures }: { captures: Captures } = $props();

	let text = $state('');
	/** Whether an Add runs: the text takes no typing until it ends. */
	let adding = $state(false);
	let failure = $state.raw<Failure>();
	const locked = $derived(adding || captures.fenced);

	async function add() {
		if (locked || text.trim() === '') return;
		adding = true;
		failure = undefined;
		const { error } = await captures.create(text);
		adding = false;
		if (error !== null) failure = error;
		else text = '';
	}
</script>

<form
	class="flex flex-col gap-2"
	onsubmit={(event) => {
		event.preventDefault();
		void add();
	}}
>
	<Field.Field>
		<Field.Label for="new-capture">New capture</Field.Label>
		<Textarea
			id="new-capture"
			readonly={locked}
			bind:value={text}
			onkeydown={(event) => {
				if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
					event.preventDefault();
					event.currentTarget.form?.requestSubmit();
				}
			}}
			rows={4}
			class="max-h-96 leading-relaxed"
			placeholder="Write or paste something…"
		/>
	</Field.Field>
	{#if failure}
		<Alert.Root variant="destructive" role="alert">
			<Alert.Title>The capture was not added</Alert.Title>
			<Alert.Description>{describeFailure(failure)} Your text is still here.</Alert.Description>
		</Alert.Root>
	{/if}
	<div class="flex items-center justify-between gap-3">
		<p class="text-xs text-muted-foreground">Ctrl or ⌘ + Enter adds it.</p>
		<Button type="submit" size="sm" disabled={locked || text.trim() === ''}>{adding ? 'Adding…' : 'Add capture'}</Button>
	</div>
</form>
