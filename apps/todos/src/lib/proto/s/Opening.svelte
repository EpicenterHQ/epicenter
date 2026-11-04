<!--
	PROTOTYPE option (s), standing for `@epicenter/svelte`'s `<Opening>`:
	a spinner while the folder opens, Recovery with Retry when it failed, and
	`children` only once it is ready. It shows the folder's state; it catches
	no error, so a page's own bug never reaches its Recovery.
-->
<script lang="ts" generics="TClient">
	import type { Snippet } from 'svelte';
	import type { Folder } from './folder.js';
	import { fromFolder } from './from-folder.svelte.js';

	let { folder, children }: { folder: Folder<TClient>; children: Snippet } = $props();
	// svelte-ignore state_referenced_locally
	const opened = fromFolder(folder);
</script>

{#if opened.state.status === 'opening'}
	<p data-testid="pending">Opening…</p>
{:else if opened.state.status === 'failed'}
	<main data-testid="recovery">
		<p>recovery: {opened.state.error.message}</p>
		<button onclick={() => folder.retry()}>Retry</button>
	</main>
{:else}
	{@render children()}
{/if}
