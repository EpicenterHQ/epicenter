<!--
	Vocab's desktop startup: its data folder (`DesktopStartup`), opened with
	the shell's answer to who, if anyone, is signed in, then the app over it
	(`DesktopRoot`). Vocab keeps no settings note of its own in AppData; the
	connected endpoints there are `@epicenter/ai`'s (`customEndpoints()`).
-->
<script lang="ts">
	import DesktopStartup from '@epicenter/svelte/desktop-startup';
	import { APPS } from '@epicenter/definition/site';
	import type { Snippet } from 'svelte';
	import { authReady } from '../auth.tauri.js';
	import { vocab } from '../contract.js';
	import DesktopRoot from './DesktopRoot.svelte';

	let { children: pages }: { children: Snippet } = $props();
</script>

<DesktopStartup app="Vocab" contract={vocab} site={APPS.VOCAB.url} ready={authReady}>
	{#snippet children(_appData, device, site)}
		<DesktopRoot {device} {site}>{@render pages()}</DesktopRoot>
	{/snippet}
</DesktopStartup>
