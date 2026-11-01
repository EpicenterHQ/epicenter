<!-- The note editor bound to one note's body as `NoteDetail` binds it, for `editor.dom.test.ts`. -->
<script lang="ts">
	import type { ReactiveNotes } from '@epicenter/svelte/client';
	import type { NoteCollection } from '$lib/honeycrisp.svelte.js';
	import NoteEditor from './NoteEditor.svelte';

	let { notes, id }: { notes: ReactiveNotes<NoteCollection>; id: string } = $props();
	// svelte-ignore state_referenced_locally
	const edit = notes.edit({ id });
</script>

{#if edit.exists}
	<NoteEditor body={edit.fields.body ?? ''} onEdit={(text) => (edit.fields.body = text)} />
{/if}
