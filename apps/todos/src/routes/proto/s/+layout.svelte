<!-- PROTOTYPE option (s): the root layout, with no await. `?peek` adds a reader outside `<Opening>`. -->
<script lang="ts">
	import { onDestroy } from 'svelte';
	import { page } from '$app/state';
	import { openApp, setApp } from '$lib/proto/s/app.js';
	import Opening from '$lib/proto/s/Opening.svelte';
	import Peek from '$lib/proto/s/Peek.svelte';

	let { children } = $props();

	const app = openApp();
	setApp(app);
	onDestroy(() => app[Symbol.dispose]());
</script>

{#if page.url.searchParams.has('peek')}<Peek />{/if}
<Opening folder={app.folder}>{@render children()}</Opening>
