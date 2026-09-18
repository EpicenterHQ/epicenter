<script lang="ts">
	import { InferencePicker } from '@epicenter/app-shell/inference-picker';
	import * as Alert from '@epicenter/ui/alert';
	import * as Field from '@epicenter/ui/field';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { resolveCompletionState } from '$lib/state/completion.svelte';
	import { getWhisperingApp } from '$lib/whispering/context';

	const whispering = getWhisperingApp();
	const state = $derived(resolveCompletionState());
</script>

<Field.Group>
	<Field.Field>
		<Field.Label>Text connection and model</Field.Label>
		<InferencePicker
			scope="completion"
			model={whispering.settings.get('completionModel')}
			connections={whispering.inferenceConnections}
			onSelectModel={(model) => whispering.settings.set('completionModel', model)}
		/>
		<Field.Description>
			Polish and Recipes use this selection. Connect a provider from the picker,
			then choose a model or enter its ID. Connections are shared across apps for this account and profile. Browser sharing is limited to this origin.
		</Field.Description>
	</Field.Field>
	{#if state.canRun}
		<p class="text-muted-foreground text-sm">Transcript text is sent to {state.destination}.</p>
	{:else}
		<Alert.Root variant="warning">
			<TriangleAlertIcon class="size-4" />
			<Alert.Description>
				Choose a text connection and model. Until then, transcripts ship raw and Recipes cannot run.
			</Alert.Description>
		</Alert.Root>
	{/if}
</Field.Group>
