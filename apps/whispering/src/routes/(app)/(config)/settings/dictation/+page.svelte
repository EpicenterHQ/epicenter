<script lang="ts">
	import PersonalBoundary from '$lib/components/PersonalBoundary.svelte';
	import * as Field from '@epicenter/ui/field';
	import DeviceCleanupSettings from './DeviceCleanupSettings.svelte';
	import PersonalSettings from './PersonalSettings.svelte';
</script>

<svelte:head><title>Dictation Settings - Whispering</title></svelte:head>

<Field.Set>
	<Field.Legend>Dictation</Field.Legend>
	<Field.Description>
		Control how Whispering cleans and spells your transcriptions.
	</Field.Description>
	<DeviceCleanupSettings />
	<Field.Separator />
	<PersonalBoundary><PersonalSettings /></PersonalBoundary>
</Field.Set>
