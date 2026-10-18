<!--
	"Still saving…" while closing the window has run longer than a moment,
	with "Close anyway", which stops waiting and lets the window go. What was
	still saving then may be lost. Shown only while `closing.slow`.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import type { Closing } from './closing.svelte.js';

	let { closing }: { closing: Pick<Closing, 'slow' | 'closeAnyway'> } =
		$props();
</script>

{#if closing.slow}
	<div
		role="status"
		data-testid="closing-notice"
		class="fixed inset-x-4 bottom-4 z-50 mx-auto flex w-fit max-w-[calc(100%-2rem)] items-center gap-3 rounded-lg border bg-popover px-4 py-3 text-sm text-popover-foreground shadow-lg"
	>
		<span>Still saving…</span>
		<Button size="sm" variant="outline" onclick={() => closing.closeAnyway()}>
			Close anyway
		</Button>
	</div>
{/if}
