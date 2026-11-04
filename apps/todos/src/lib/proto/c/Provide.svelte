<!-- Sets the open world for every page under it, during its own setup. -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { World } from '../open.js';
	import { setWorld } from './world.js';

	let { world, children }: { world: World; children: Snippet } = $props();
	// svelte-ignore state_referenced_locally
	setWorld(world);
</script>

{@render children()}
