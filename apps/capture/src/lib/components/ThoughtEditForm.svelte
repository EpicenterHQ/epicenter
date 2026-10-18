<!--
	The form that edits one thought: its text box, Save thought, and Cancel.

	It belongs to the one edit open when it was made. Every action names that
	edit, which the form refuses unless it is the edit open now, and the form
	does nothing once destroyed: a later edit, of another thought or of this
	same one again, has its own form.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Textarea } from '@epicenter/ui/textarea';
	import { onDestroy, untrack } from 'svelte';
	import type { CaptureForm, ThoughtEdit } from '$lib/capture-form.svelte.js';

	let {
		form,
		edit,
		locked,
		onSaved,
		onCancelled,
	}: {
		form: CaptureForm;
		/** Input is refused now: leaving, closing, or deleting. */
		locked: boolean;
		/** The edit open when this form was made. */
		edit: ThoughtEdit;
		onSaved: () => void;
		onCancelled: () => void;
	} = $props();

	/** The edit this form was made for; a later edit has another identity. */
	const id = untrack(() => edit.id);
	let live = true;
	onDestroy(() => {
		live = false;
	});
	const own = () => live && form.editing?.id === id;
	const text = $derived(form.editing?.id === id ? form.editing.text : '');

	const rowsFor = (value: string) => Math.min(12, Math.max(3, value.split('\n').length + 1));

	function submitOnModEnter(event: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) {
		if (!(event.metaKey || event.ctrlKey) || event.key !== 'Enter') return;
		event.preventDefault();
		event.currentTarget.form?.requestSubmit();
	}

	function focusAtEnd(node: HTMLTextAreaElement) {
		node.focus();
		node.setSelectionRange(node.value.length, node.value.length);
	}
</script>

<form
	class="flex flex-col gap-2 py-1"
	onsubmit={(event) => {
		event.preventDefault();
		if (own() && form.commitEditing(id)) onSaved();
	}}
>
	<Textarea
		aria-label="Thought text"
		readonly={locked}
		bind:value={
			() => text,
			(value) => {
				if (own()) form.inputEditing(value, id);
			}
		}
		onkeydown={submitOnModEnter}
		rows={rowsFor(text)}
		class="leading-relaxed"
		{@attach focusAtEnd}
	/>
	<div class="flex flex-wrap gap-2">
		<Button type="submit" size="sm" disabled={locked}>Save thought</Button>
		<Button
			size="sm"
			variant="outline"
			onclick={() => {
				if (!own()) return;
				form.cancelEditing(id);
				onCancelled();
			}}>Cancel</Button
		>
	</div>
</form>
