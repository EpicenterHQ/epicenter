<!--
	Whispering's desktop startup: its data folder (`DesktopStartup` from
	`@epicenter/svelte`), then the app over it (`DesktopRoot`, then
	`children`). This computer's own state, such as the shortcut's override,
	is each capability's own (`localFile` from `@epicenter/local`).
-->
<script lang="ts">
	import type { Client } from '@epicenter/definition/contract';
	import { APPS } from '@epicenter/definition/site';
	import type { Folder } from '@epicenter/folder/core';
	import DesktopStartup from '@epicenter/svelte/desktop-startup';
	import type { Snippet } from 'svelte';
	import { type Whispering, whispering } from '../contract.js';
	import DesktopRoot from './DesktopRoot.svelte';

	let { children: outer }: { children: Snippet<[Client<Whispering>, Folder<Whispering>]> } = $props();
</script>

<DesktopStartup app="Whispering" contract={whispering} site={APPS.WHISPERING.url}>
	{#snippet children(_appData, device, site)}
		<DesktopRoot {device} {site}>
			{#snippet children(files)}
				{@render outer(device, files)}
			{/snippet}
		</DesktopRoot>
	{/snippet}
</DesktopStartup>
