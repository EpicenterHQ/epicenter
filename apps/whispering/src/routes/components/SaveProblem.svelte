<!--
	Why an editor's last save did not happen, with what the person can do.
	When the note changed elsewhere since it was shown, the newer note is
	shown and nothing more is saved until the person keeps what they typed
	(written over the newer note) or discards it. Any other failure keeps
	the typing and offers to try again.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import type { NoteWriteError } from '$lib/notes.js';

	let {
		editor,
	}: {
		editor: { problem(): NoteWriteError | null; retry(): void; discard(): void };
	} = $props();
	const problem = $derived(editor.problem());
</script>

{#if problem}
	<div class="flex flex-col gap-1.5 rounded border border-destructive/50 p-2 text-xs" role="alert" data-testid="save-problem" data-problem={problem.name}>
		{#if problem.name === 'Changed'}
			<p>This changed elsewhere since it was shown, so what you typed was not saved. The newer text is shown wherever you have not typed.</p>
			<div class="flex gap-1">
				<Button size="xs" onclick={() => editor.retry()} data-testid="keep-mine">Keep mine</Button>
				<Button size="xs" variant="ghost" onclick={() => editor.discard()} data-testid="show-newer">Show the newer text</Button>
			</div>
		{:else}
			<p>Not saved: {problem.message}</p>
			<div class="flex gap-1">
				<Button size="xs" onclick={() => editor.retry()} data-testid="save-retry">Try again</Button>
				<Button size="xs" variant="ghost" onclick={() => editor.discard()}>Discard changes</Button>
			</div>
		{/if}
	</div>
{/if}
