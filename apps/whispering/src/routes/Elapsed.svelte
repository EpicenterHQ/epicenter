<!-- The time since `since`, as `0:42`, ticking four times a second while shown. -->
<script lang="ts">
	import { cn } from '@epicenter/ui/utils';
	import { formatDuration } from '#lib/feed.ts';

	let { since, class: className }: { since: number; class?: string } = $props();

	let now = $state(Date.now());
	$effect(() => {
		const timer = setInterval(() => (now = Date.now()), 250);
		return () => clearInterval(timer);
	});
</script>

<span class={cn('tabular-nums', className)}>{formatDuration(Math.max(0, now - since))}</span>
