<script lang="ts">
	import type { Snippet } from 'svelte';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { getWhisperingApp } from '../whispering/context.js';
	import PersonalProvider from './PersonalProvider.svelte';
	let { children }: { children: Snippet } = $props();
	const app = getWhisperingApp();
</script>

{#await app.personalReady}
	<p role="status">Opening Personal… Local recording remains available.</p>
{:then personal}
	{#if personal}
		<PersonalProvider {personal}>{@render children()}</PersonalProvider>
	{:else}
		<p>Sign in to use Personal.</p>
	{/if}
{:catch error}
	<p role="alert">Personal could not open: {extractErrorMessage(error)}</p>
{/await}
