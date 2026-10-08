<script lang="ts">
	import { fromSubscription } from '@epicenter/svelte';
	import { Button } from '@epicenter/ui/button';
	import { getRecordingEditor } from '$lib/whispering/context';

	const editor = getRecordingEditor();
	const state = fromSubscription(editor.subscribe, () => editor.state);
</script>

{#if state.current.drafts.length}
	<section class="space-y-2" aria-label="Unsaved recording drafts">
		<p class="text-sm font-medium">Unsaved drafts</p>
		<div class="flex flex-wrap gap-2">
			{#each state.current.drafts as draft (draft.id)}
				<Button variant="outline" size="sm" onclick={() => editor.open(draft.id)}>
					{draft.title}{draft.missing ? ' (recording unavailable)' : ''}
				</Button>
			{/each}
		</div>
	</section>
{/if}
