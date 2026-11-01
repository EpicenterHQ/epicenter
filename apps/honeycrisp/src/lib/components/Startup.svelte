<!--
	Honeycrisp's desktop startup: its two roots (`DesktopStartup`), then the app
	over them (`DesktopRoot`).
-->
<script lang="ts">
	import { desktopSettings } from '@epicenter/folder/tauri';
	import DesktopStartup from '@epicenter/svelte/desktop-startup';
	import type { Snippet } from 'svelte';
	import { honeycrisp } from '../contract.js';
	import DesktopRoot from './DesktopRoot.svelte';

	let { children: pages }: { children: Snippet } = $props();
</script>

<DesktopStartup app="Honeycrisp" settings={desktopSettings} contract={honeycrisp}>
	{#snippet children(appData, device)}
		<DesktopRoot {appData} {device}>{@render pages()}</DesktopRoot>
	{/snippet}
</DesktopStartup>
