<!--
	Whispering's web build, the local variant: its pages over this browser's
	files (`$lib/device.ts`) for the page's whole life. It needs no account
	and works offline; nothing here ever uploads, and signing in only adds
	hosted transcription and AI (ADR-0700). This is the only place the web
	build chooses its store.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { device } from '$lib/device.js';
	import WhisperingApp from '../components/WhisperingApp.svelte';

	let { children }: { children: Snippet } = $props();
</script>

<WhisperingApp client={device}>{@render children()}</WhisperingApp>
