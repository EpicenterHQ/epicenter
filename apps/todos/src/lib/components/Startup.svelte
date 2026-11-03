<!--
	Todos' desktop startup: its two roots (`DesktopStartup`), then the app
	over them (`DesktopRoot`).
-->
<script lang="ts">
	import DesktopStartup from '@epicenter/svelte/desktop-startup';
	import type { Snippet } from 'svelte';
	import { todos } from '../contract.js';
	import DesktopRoot from './DesktopRoot.svelte';

	let { children: pages }: { children: Snippet } = $props();
</script>

<DesktopStartup app="Todos" contract={todos}>
	{#snippet children(_appData, device)}
		<DesktopRoot {device}>{@render pages()}</DesktopRoot>
	{/snippet}
</DesktopStartup>
