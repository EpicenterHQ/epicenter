<script lang="ts">
	import { local } from '$lib/whispering/local.js';
	import { getInferenceTarget } from '$lib/whispering/inference.js';
	import { InferencePicker } from '@epicenter/app-shell/inference-picker';
	import * as Alert from '@epicenter/ui/alert';
	import * as Field from '@epicenter/ui/field';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { resolveCompletionTarget } from '$lib/operations/completion.js';
	import { completionDestination } from '$lib/state/polish.js';
	import { getWhisperingApp } from '$lib/whispering/context';

	const whispering = getWhisperingApp();
	const state = $derived(resolveCompletionTarget(whispering));
</script>

<Field.Group>
	<Field.Field>
		<Field.Label>Text connection and model</Field.Label>
		<InferencePicker
			value={getInferenceTarget(local.kv, 'completion')}
			catalog={whispering.catalog}
			onSelect={({ connectionId, model }) =>
				local.kv.update({
					completionConnection: connectionId,
					completionModel: model,
				})}
		/>
		<Field.Description>
			Polish and Recipes use this selection. Connect a provider from the picker,
			then choose a model or enter its ID. Connections are shared across apps
			for this account and profile. Browser sharing is limited to this origin.
		</Field.Description>
	</Field.Field>
	{#if state}
		<p class="text-muted-foreground text-sm">
			Transcript text is sent to {completionDestination(state)}.
		</p>
	{:else}
		<Alert.Root variant="warning">
			<TriangleAlertIcon class="size-4" />
			<Alert.Description>
				Choose a text connection and model. Until then, transcripts ship raw and
				Recipes cannot run.
			</Alert.Description>
		</Alert.Root>
	{/if}
</Field.Group>
