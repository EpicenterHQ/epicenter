<!--
	Vocab's desktop startup: its two roots (`DesktopStartup`), opened with
	the shell's answer to who, if anyone, is signed in, then the app over
	them (`DesktopRoot`).
-->
<script lang="ts">
	import DesktopStartup from '@epicenter/svelte/desktop-startup';
	import type { Snippet } from 'svelte';
	import { authReady } from '../auth.tauri.js';
	import { vocab } from '../contract.js';
	import { vocabSettings } from '../folder.tauri.js';
	import DesktopRoot from './DesktopRoot.svelte';

	let { children: pages }: { children: Snippet } = $props();
</script>

<DesktopStartup app="Vocab" settings={vocabSettings} contract={vocab} ready={authReady}>
	{#snippet children(appData, device)}
		{#if appData}<DesktopRoot {appData} {device}>{@render pages()}</DesktopRoot>{/if}
	{/snippet}
</DesktopStartup>
