<!--
	Capture's desktop startup: its two roots (`DesktopStartup`), then the app
	over them (`DesktopRoot`).
-->
<script lang="ts">
	import DesktopStartup from '@epicenter/svelte/desktop-startup';
	import type { Snippet } from 'svelte';
	import { capture } from '@epicenter/capture';
	import { CONTRACT_URL } from '../folder.tauri.js';
	import DesktopRoot from './DesktopRoot.svelte';

	let { children: pages }: { children: Snippet } = $props();
</script>

<DesktopStartup app="Capture" contract={capture} contractUrl={CONTRACT_URL}>
	{#snippet children(_appData, device)}
		<DesktopRoot {device}>{@render pages()}</DesktopRoot>
	{/snippet}
</DesktopStartup>
