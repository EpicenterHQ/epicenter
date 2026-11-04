<!--
	PROTOTYPE option (c) as reviewed: sets the app's context during its own
	setup (a layout cannot after an `await`) and disposes the app with itself.
-->
<script lang="ts">
	import { onDestroy, type Snippet } from 'svelte';
	import { type App, setApp } from './app.js';

	let { app, children }: { app: App; children: Snippet } = $props();
	// svelte-ignore state_referenced_locally
	setApp(app);
	// svelte-ignore state_referenced_locally
	onDestroy(() => app[Symbol.dispose]());
</script>

{@render children()}
