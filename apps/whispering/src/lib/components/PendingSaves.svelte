<script lang="ts">
	import { fromSubscription } from '@epicenter/svelte';
	import { Button } from '@epicenter/ui/button';
	import type { createPendingSaves } from '../whispering/pending-saves.js';
	let {
		saves,
		signal,
	}: { saves: ReturnType<typeof createPendingSaves>; signal: AbortSignal } =
		$props();
	const pending = fromSubscription(
		(notify) => saves.subscribe(notify),
		() => saves.entries,
	);
</script>

{#each pending.current.filter((entry) => entry.error) as entry}
	<div class="flex items-center gap-3 border-b p-3 text-sm" role="status">
		<p>
			{entry.label}: {entry.error?.message} Recovery ends when this page closes.
		</p>
		<Button
			disabled={entry.busy || signal.aborted}
			onclick={() => entry.retry()}>Finish saving</Button
		>
	</div>
{/each}
