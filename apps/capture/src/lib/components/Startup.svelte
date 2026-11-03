<!--
	Capture's desktop startup: its two roots (`DesktopStartup`), then the app
	over them (`DesktopRoot`).
-->
<script lang="ts">
	import DesktopStartup from '@epicenter/svelte/desktop-startup';
	import { APPS } from '@epicenter/constants/apps';
	import type { Snippet } from 'svelte';
	import { capture } from '@epicenter/capture';
		import DesktopRoot from './DesktopRoot.svelte';

	let { children: pages }: { children: Snippet } = $props();
</script>

<DesktopStartup app="Capture" contract={capture} site={APPS.CAPTURE.url}>
	{#snippet children(_appData, device, site)}
		<DesktopRoot {device} {site}>{@render pages()}</DesktopRoot>
	{/snippet}
</DesktopStartup>
