<script lang="ts">
	import type { Snippet } from 'svelte';
	import { setWorld } from '$lib/proto/c/world.js';
	import { openWorld } from '$lib/proto/open.js';

	let { children }: { children: Snippet } = $props();
	const world = await openWorld('cn');
	setWorld(world);
</script>

{@render children()}
