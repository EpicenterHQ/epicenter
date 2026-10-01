<script lang="ts">
	import { getWhisperingApp } from '$lib/whispering/context.js';
	import { extractErrorMessage } from 'wellcrafted/error';
	import * as Field from '@epicenter/ui/field';
	import DeviceCleanupSettings from './DeviceCleanupSettings.svelte';
	import PersonalSettings from './PersonalSettings.svelte';
	const app = getWhisperingApp();
</script>

<svelte:head><title>Dictation Settings - Whispering</title></svelte:head>

<Field.Set>
	<Field.Legend>Dictation</Field.Legend>
	<Field.Description>
		Control how Whispering cleans and spells your transcriptions.
	</Field.Description>
	<DeviceCleanupSettings />
	<Field.Separator />
	{#await app.personalReady}
		<p role="status">Opening your speech profile…</p>
	{:then personal}
		{#if personal}
			<PersonalSettings {personal} />
		{:else}
			<p>Sign in to use your speech profile.</p>
		{/if}
	{:catch error}
		<p role="alert">Your speech profile could not open: {extractErrorMessage(error)}</p>
	{/await}
</Field.Set>
