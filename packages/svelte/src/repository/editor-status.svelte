<!--
	Where a note's editor stands, for any view of it: saved, saving, failed
	(Try again), or closed. A clash with a change made elsewhere is a
	conflict block in the text, not a state: nothing waits for a choice. Given `check`, it also says whether the
	text's fields fit its schema (a text whose frontmatter does not parse has none); given the note's `state`, that the text
	is saved here and held, not sent, and why.

	```svelte
	<EditorStatus {editor} check={(text) => app.check(text, { as: 'notes' })} state={note.state} />
	```
-->
<script lang="ts">
	import type { Editor, EditorState, FileStatus, TextStatus } from '@epicenter/repository';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { untrack } from 'svelte';

	let {
		editor,
		check,
		// Not named `state`, which would make `$state` read as a store.
		state: noteState,
		class: className = '',
	}: {
		editor: Editor;
		/** Whether the note's fields fit its schema, shown as the person types. */
		check?: (text: string) => TextStatus;
		/** The note's state as the repository lists it: a held note says why it is not sent. */
		state?: FileStatus;
		class?: string;
	} = $props();

	let saving = $state.raw<EditorState>(untrack(() => editor.state()));
	let status = $state.raw<TextStatus>();

	$effect(() => {
		const current = editor;
		const checking = check;
		const read = () => {
			saving = current.state();
			status = checking?.(current.draft());
		};
		read();
		return current.subscribe(read);
	});
</script>

<div class={['shrink-0 space-y-1 border-t px-3 py-2 text-xs', className]} role="status" data-testid="editor-status" data-state={saving.status}>
	{#if status?.matches === false}
		<p><Badge variant="destructive">Doesn't match the schema</Badge></p>
		<ul class="space-y-0.5 text-muted-foreground">
			{#each status.issues as issue (issue)}
				<li>{issue}</li>
			{/each}
		</ul>
	{:else if status?.matches === true}
		<p><Badge variant="secondary">Matches the schema</Badge></p>
	{/if}
	{#if noteState?.status === 'refused'}
		<p class="text-muted-foreground" data-testid="editor-refused">Saved on this device, not sent until it is fixed: {noteState.reason}.</p>
	{:else if noteState?.status === 'waiting'}
		<p class="text-muted-foreground" data-testid="editor-waiting">Saved on this device, waiting to send: {noteState.reason}.</p>
	{/if}
	{#if saving.status === 'failed'}
		<p class="flex flex-wrap items-center gap-2 text-destructive">
			Not saved: {saving.error.message}
			<Button size="sm" variant="outline" onclick={() => editor.retry()}>Try again</Button>
		</p>
	{:else if saving.status === 'closed'}
		<p class="text-muted-foreground">Closed; this text is kept here but no longer saved.</p>
	{:else}
		<p class="text-muted-foreground">{saving.status === 'saving' ? 'Saving…' : 'Saved'}</p>
	{/if}
</div>
