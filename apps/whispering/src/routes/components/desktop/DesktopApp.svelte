<!--
	Whispering over the folder the desktop window opened: the same app
	component as the browser's, with `device` the folder (decision 78), the
	folder's path in context for the desktop-only pieces, and the global
	shortcut, which starts and stops a recording like the button.
-->
<script lang="ts">
	import type { Client } from '@epicenter/definition/contract';
	import type { Snippet } from 'svelte';
	import type { Whispering as WhisperingContract } from '$lib/contract.js';
	import WhisperingApp from '../WhisperingApp.svelte';
	import { setDesktop } from './context.js';
	import ShortcutListener from './ShortcutListener.svelte';

	let {
		folder,
		device,
		children,
	}: {
		folder: string;
		device: Client<WhisperingContract>;
		children: Snippet;
	} = $props();

	// svelte-ignore state_referenced_locally
	setDesktop({ folder });
</script>

<WhisperingApp {device}>
	<ShortcutListener />
	{@render children()}
</WhisperingApp>
