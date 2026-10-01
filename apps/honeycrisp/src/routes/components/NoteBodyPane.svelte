<script lang="ts">
	import { onDestroy } from 'svelte';
	import type { HoneycrispData, NoteId } from '$lib/data.js';
	import HoneycrispEditor from '$lib/editor/Editor.svelte';
	import { openContent } from '$lib/notes.js';

	let props: {
		data: HoneycrispData;
		noteId: NoteId;
		focusRequest: number;
	} = $props();

	// Notes fixes the data for this mount and keys the pane by note id.
	// svelte-ignore state_referenced_locally
	const opened = openContent(props.data, props.noteId);
	onDestroy(() => opened?.close());
</script>

{#if opened}
	<div class="flex h-full flex-col">
		<div class="min-h-0 flex-1">
			<HoneycrispEditor
				yxmlfragment={opened.content}
				focusRequest={props.focusRequest}
			/>
		</div>
	</div>
{:else}
	<div class="flex h-full items-center justify-center p-6 text-center">
		<p class="text-sm text-muted-foreground">This note is no longer here.</p>
	</div>
{/if}
