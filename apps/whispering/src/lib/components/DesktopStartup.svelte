<!--
	Whispering's desktop startup: its two roots (`DesktopStartup` from
	`@epicenter/svelte`), then the app over the data folder (`DesktopRoot`,
	then `children`).
-->
<script lang="ts">
	import type { Client } from '@epicenter/definition/contract';
	import { APPS } from '@epicenter/constants/apps';
	import type { ReactiveClient } from '@epicenter/svelte/client';
	import DesktopStartup from '@epicenter/svelte/desktop-startup';
	import type { Snippet } from 'svelte';
	import { type Whispering, whispering } from '../contract.js';
	import { whisperingSettings } from '../settings.tauri.js';
	import DesktopRoot from './DesktopRoot.svelte';

	let { children: outer }: { children: Snippet<[Client<Whispering>, ReactiveClient<Whispering>]> } = $props();
</script>

<DesktopStartup app="Whispering" settings={whisperingSettings} contract={whispering} site={APPS.WHISPERING.url}>
	{#snippet children(appData, device, site)}
		{#if appData}<DesktopRoot {appData} {device} {site}>
			{#snippet children(files)}
				{@render outer(device, files)}
			{/snippet}
		</DesktopRoot>{/if}
	{/snippet}
</DesktopStartup>
