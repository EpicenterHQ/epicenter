<script>
	import { fade } from 'svelte/transition';

	const terms = [
		'minds that matter',
		'the renaissance mind',
		'polymaths',
		'interdisciplinary thinkers',
		'the endlessly curious',
		'the liberal arts',
		'humans, not users',
		'thinkers who build',
		'builders who think',
	];

	let currentIndex = $state(0);

	$effect(() => {
		const interval = setInterval(() => {
			currentIndex = (currentIndex + 1) % terms.length;
		}, 3500); // Faster rotation shorter phrases

		return () => clearInterval(interval);
	});
</script>

<h2 class="text-3xl md:text-5xl font-bold text-foreground mb-6">
	Principles for
	<span class="relative inline-block">
		{#each terms as term, index}
			{#if index === currentIndex}
				<span
					class="absolute left-0 top-0 whitespace-nowrap text-primary"
					in:fade={{ duration: 400 }}
					out:fade={{ duration: 400 }}
				>
					{term}
				</span>
			{/if}
		{/each}
		<!-- Invisible placeholder to maintain width -->
		<span class="invisible">thinkers who build</span>
	</span>
</h2>
