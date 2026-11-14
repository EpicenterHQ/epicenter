<script lang="ts">
	/** Elapsed time of the live recording as `m:ss`, ticking only while mounted. */
	let { startedAt }: { startedAt: number } = $props();

	let elapsed = $state(0);
	$effect(() => {
		const from = startedAt;
		const tick = () => (elapsed = Math.max(0, Math.floor((performance.now() - from) / 1000)));
		tick();
		const timer = setInterval(tick, 250);
		return () => clearInterval(timer);
	});
</script>

<span class="tabular-nums" data-testid="recorder-clock">{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</span>
