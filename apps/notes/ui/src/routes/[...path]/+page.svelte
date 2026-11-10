<!-- Each path owns its editor for as long as that note is open. -->
<script lang="ts">
	import { page } from '$app/state';
	import NoteEditor from '$lib/components/NoteEditor.svelte';
	import NotesShell from '$lib/components/NotesShell.svelte';
	const path = $derived(page.params.path ?? '');
</script>

<NotesShell open={path}>
	{#key path}<NoteEditor {path} />{/key}
</NotesShell>
