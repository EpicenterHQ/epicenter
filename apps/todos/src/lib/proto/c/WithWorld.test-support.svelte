<!-- PROTOTYPE test support: sets a fake world, then renders the component under test. -->
<script lang="ts">
	import type { Component } from 'svelte';
	import type { World } from '../open.js';
	import { setWorld } from './world.js';

	let { world, Child }: { world: World; Child: Component } = $props();
	// svelte-ignore state_referenced_locally
	setWorld(world);
</script>

<Child />
