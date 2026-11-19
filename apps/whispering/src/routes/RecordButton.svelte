<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Spinner } from '@epicenter/ui/spinner';
	import CircleIcon from '@lucide/svelte/icons/circle';
	import SquareIcon from '@lucide/svelte/icons/square';
	import { dictation } from '#lib/dictation.svelte.ts';
	import { formatDuration } from '#lib/feed.ts';

	/** The clock, ticking only while a recording runs. */
	let now = $state(Date.now());
	$effect(() => {
		if (dictation.status.kind !== 'recording') return;
		now = Date.now();
		const timer = setInterval(() => (now = Date.now()), 250);
		return () => clearInterval(timer);
	});
</script>

{#if dictation.status.kind === 'recording'}
	<Button variant="destructive" onclick={() => dictation.toggle()}>
		<SquareIcon class="fill-current" />
		Stop {formatDuration(Math.max(0, now - dictation.status.startedAt))}
	</Button>
{:else if dictation.status.kind === 'idle'}
	<Button onclick={() => dictation.toggle()}>
		<CircleIcon class="fill-current text-red-500" />
		Record
	</Button>
{:else}
	<Button disabled>
		<Spinner />
		{dictation.status.kind === 'starting' ? 'Starting' : 'Saving'}
	</Button>
{/if}
