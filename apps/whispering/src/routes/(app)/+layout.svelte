<!--
	Whispering's root over its folder (ADR-0766): `<WhenOpen>` shows a
	spinner while the folder opens, Recovery when it cannot, and the app once
	it has, and asks before the page is left while a save is out. The folder
	is the build's one store, `src/lib/app.ts`'s: this browser's storage for
	good on the web, with no account needed and nothing ever uploaded
	(ADR-0700), and the data folder on the desktop. The app finishes starting
	under this boundary's spinner. The sign-in callback is outside this group.
-->
<script lang="ts">
	import WhenOpen from '@epicenter/svelte/when-open';
	import { Loading } from '@epicenter/ui/loading';
	import type { Snippet } from 'svelte';
	import { folder } from '$lib/app.js';
	import WhisperingApp from '../components/WhisperingApp.svelte';

	let { children }: { children: Snippet } = $props();
</script>

<WhenOpen app="Whispering" {folder}>
	<svelte:boundary>
		{#snippet pending()}
			<Loading class="h-dvh" />
		{/snippet}
		<WhisperingApp>{@render children()}</WhisperingApp>
	</svelte:boundary>
</WhenOpen>
