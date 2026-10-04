<script lang="ts">
	import * as Field from '@epicenter/ui/field';
	import OutputDeliveryControls from '$lib/components/OutputDeliveryControls.svelte';
	import { tauri } from '#platform/tauri';
	import AutostartSwitch from './AutostartSwitch.svelte';
</script>

<svelte:head> <title>Settings - Whispering</title> </svelte:head>

<Field.Set>
	<Field.Legend>General</Field.Legend>
	<Field.Description>
		Configure your general Whispering preferences.
	</Field.Description>
	<Field.Group>
		<Field.Set>
			<Field.Legend variant="label">Transcription output</Field.Legend>
			<Field.Description>
				Applies immediately after an audio transcription finishes.
			</Field.Description>
			<Field.Group>
				<OutputDeliveryControls scope="transcription" />
			</Field.Group>
		</Field.Set>

		<Field.Set>
			<Field.Legend variant="label">Recipe output</Field.Legend>
			<Field.Description>
				Applies after you run a Recipe on your selection or clipboard.
			</Field.Description>
			<Field.Group>
				<OutputDeliveryControls scope="recipe" />
			</Field.Group>
		</Field.Set>

		{#if tauri}
			<AutostartSwitch autostart={tauri.autostart} />
		{/if}
	</Field.Group>
</Field.Set>
