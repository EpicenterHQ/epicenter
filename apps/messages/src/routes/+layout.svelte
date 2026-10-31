<!--
	Every page of Messages, under one boundary: until the page's `Startup`
	has opened this browser's files, the UI kit's spinner shows.
-->
<script lang="ts">
	import { Loading } from '@epicenter/ui/loading';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import '@epicenter/ui/app.css';
	let { children } = $props();
</script>

<svelte:head><title>Messages</title></svelte:head>
<Tooltip.Provider>
	<svelte:boundary>
		{#snippet pending()}
			<Loading class="h-dvh" />
		{/snippet}
		{@render children?.()}
	</svelte:boundary>
</Tooltip.Provider>
<Toaster closeButton />
