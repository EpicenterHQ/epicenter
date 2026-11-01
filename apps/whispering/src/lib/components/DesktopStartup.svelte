<!--
	Whispering's desktop startup: its two roots (`DesktopStartup` from
	`@epicenter/svelte`), then the app over the data folder (`DesktopRoot`,
	then `children`).
-->
<script lang="ts">
	import type { Client } from '@epicenter/definition/contract';
	import type { ReactiveClient } from '@epicenter/svelte/client';
	import DesktopStartup from '@epicenter/svelte/desktop-startup';
	import type { Snippet } from 'svelte';
	import { type Whispering, whispering } from '../contract.js';
	import { whisperingSettings } from '../settings.tauri.js';
	import DesktopRoot from './DesktopRoot.svelte';

	let { children: outer }: { children: Snippet<[Client<Whispering>, ReactiveClient<Whispering>]> } = $props();
</script>

<DesktopStartup app="Whispering" settings={whisperingSettings} contract={whispering}>
	{#snippet children(appData, device)}
		<DesktopRoot {appData} {device}>
			{#snippet children(files)}
				{@render outer(device, files)}
			{/snippet}
		</DesktopRoot>
	{/snippet}
</DesktopStartup>
