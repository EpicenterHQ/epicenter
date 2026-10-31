<!--
	The header: the app's name, the two ways to use the recorder, "On this
	browser" (`/`) and "Online" (`/online`), with the open one marked, and
	whatever the variant puts after them (the online one's account buttons).
	Each is its own store, so each link is an ordinary link that loads a new
	page.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	const {
		variant,
		children,
	}: { variant: 'local' | 'online'; children?: Snippet } = $props();
</script>

<header>
	<h1>Recorder</h1>
	<nav class="row" aria-label="Ways to use the recorder">
		<a href="/" aria-current={variant === 'local' ? 'page' : undefined}>On this browser</a>
		<a href="/online" aria-current={variant === 'online' ? 'page' : undefined}>Online</a>
	</nav>
	{@render children?.()}
</header>
