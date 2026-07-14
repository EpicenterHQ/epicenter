	<script lang="ts">
	import type { NoteId } from '@epicenter/honeycrisp';
	import { fromDisposableCache } from '@epicenter/svelte';
	import { Loading } from '@epicenter/ui/loading';
	import HoneycripEditor from '$lib/editor/Editor.svelte';
	import { honeycrisp } from '$lib/honeycrisp';

	let { noteId, focusRequest }: { noteId: NoteId; focusRequest: number } =
		$props();

	const doc = fromDisposableCache(honeycrisp.tables.notes.docs.body, () => noteId);
	$effect(() =>
		doc.current.observeLocalUpdate(() => honeycrisp.state.notes.touch(noteId)),
	);
</script>

{#await doc.current.whenReady}
	<Loading class="h-full" />
{:then _}
	<HoneycripEditor
		yxmlfragment={doc.current.content.binding}
		{focusRequest}
		onContentChange={(change) => honeycrisp.state.notes.updateContent(noteId, change)}
	/>
{/await}
