<script lang="ts">
	import { InferencePicker } from '@epicenter/app-shell/inference-picker';
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Field from '@epicenter/ui/field';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { resolveCompletionState } from '$lib/state/completion.svelte';
	import { resolveCompletionStateFromConfig, resolveTextDestination } from '$lib/operations/completion-target';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import { getWhisperingApp } from '$lib/whispering/context';

	const app = getWhisperingApp();
	const state = $derived(resolveCompletionState());
	// Old provider fields are only an explicit setup source, never a routing fallback.
	const previous = $derived(resolveCompletionStateFromConfig({
		provider: app.settings.get('completionProvider'),
		getDeviceConfig: deviceConfig.get,
	}));
</script>

<Field.Group>
	<Field.Field>
		<Field.Label>Text connection and model</Field.Label>
		<InferencePicker
			scope="completion"
			model={app.settings.get('completionModel')}
			connections={app.inferenceConnections}
			onSelectModel={(model) => app.settings.set('completionModel', model)}
		/>
		<Field.Description>
			Polish and Recipes use this selection. Connect a provider from the picker,
			then choose a model or enter its ID. Connections and keys stay in this app on this device.
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
		{#if previous.target && previous.canRun && app.settings.get('completionModel').trim()}
			{@const target = previous.target}
			<Button variant="outline" onclick={() => {
				const model = app.settings.get('completionModel').trim();
				const id = app.inferenceConnections.add(target, [model]);
				app.inferenceConnections.select('completion', { connectionId: id, model });
				app.settings.set('completionModel', model);
			}}>
				Use saved endpoint: {app.settings.get('completionModel')} · {resolveTextDestination(app.settings.get('completionProvider'), target)}
			</Button>
		{/if}
	{/if}
</Field.Group>
