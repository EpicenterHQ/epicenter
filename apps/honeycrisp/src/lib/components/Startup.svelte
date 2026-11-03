<!--
	Honeycrisp's desktop startup: its two roots (`DesktopStartup`), then the app
	over them (`DesktopRoot`).
-->
<script lang="ts">
	import DesktopStartup from '@epicenter/svelte/desktop-startup';
	import type { Snippet } from 'svelte';
	import { honeycrisp } from '../contract.js';
	import DesktopRoot from './DesktopRoot.svelte';

	let { children: pages }: { children: Snippet } = $props();
</script>

<DesktopStartup app="Honeycrisp" contract={honeycrisp}>
	{#snippet children(_appData, device)}
		<DesktopRoot {device}>{@render pages()}</DesktopRoot>
	{/snippet}
</DesktopStartup>
