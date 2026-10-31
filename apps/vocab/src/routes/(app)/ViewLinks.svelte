<!--
	The web build's links between its two views (decision 76), "On this
	device" (`/`) and "Synced" (`/synced`), with the open one marked. Each web
	page hands them to `VocabApp`'s header; the desktop program, whose one
	view is its folder, hands its folder instead.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { resolve } from '$app/paths';
	import type { View } from '$lib/vocab.svelte.js';

	let { view }: { view: View } = $props();
</script>

<nav class="flex items-center gap-1" aria-label="Views">
	<Button size="sm" variant={view === 'device' ? 'secondary' : 'ghost'} href={resolve('/')} aria-current={view === 'device' ? 'page' : undefined}>On this device</Button>
	<Button size="sm" variant={view === 'synced' ? 'secondary' : 'ghost'} href={resolve('/synced')} aria-current={view === 'synced' ? 'page' : undefined}>Synced</Button>
</nav>
