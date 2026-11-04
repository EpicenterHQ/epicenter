<!-- PROTOTYPE test support: sets a fake app through the given setter, then renders the component under test. -->
<script lang="ts" generics="T">
	import type { Component } from 'svelte';

	let { app, set, Child }: { app: T; set: (app: T) => void; Child: Component } = $props();
	// svelte-ignore state_referenced_locally
	set(app);
</script>

<Child />
