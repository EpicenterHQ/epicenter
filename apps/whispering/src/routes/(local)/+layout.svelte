<!--
	Whispering's web build, the local variant: its pages over this browser's
	files for the page's whole life, opened by `Startup` before any page
	renders, under this boundary's spinner. It needs no account and works
	offline; nothing here ever uploads, and signing in only adds hosted
	transcription and AI (ADR-0700). This is the only place the web build
	chooses its store.
-->
<script lang="ts">
	import { Loading } from '@epicenter/ui/loading';
	import type { Snippet } from 'svelte';
	import Startup from '../components/Startup.svelte';

	let { children }: { children: Snippet } = $props();
</script>

<svelte:boundary>
	{#snippet pending()}
		<Loading class="h-dvh" />
	{/snippet}
	<Startup>{@render children()}</Startup>
</svelte:boundary>
