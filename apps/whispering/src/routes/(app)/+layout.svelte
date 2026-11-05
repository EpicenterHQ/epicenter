<!--
	Whispering's root over its folder and this computer's settings
	(ADR-0766, ADR-0778): `<WhenOpen>` shows a spinner while they connect,
	Recovery when they cannot, and the app once both have, and asks before
	the page is left while a save is out. The folder
	is the build's one store, `src/lib/app.ts`'s: this browser's storage for
	good on the web, with no account needed and nothing ever uploaded
	(ADR-0700), and the data folder on the desktop. The sign-in callback is
	outside this group.
-->
<script lang="ts">
	import WhenOpen from '@epicenter/svelte/when-open';
	import type { Snippet } from 'svelte';
	import { folder, settings } from '$lib/app.js';
	import WhisperingApp from '../components/WhisperingApp.svelte';

	let { children }: { children: Snippet } = $props();
</script>

<WhenOpen app="Whispering" {folder} {settings}>
	<WhisperingApp>{@render children()}</WhisperingApp>
</WhenOpen>
