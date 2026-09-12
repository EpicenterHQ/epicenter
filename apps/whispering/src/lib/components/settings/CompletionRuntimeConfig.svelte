<script lang="ts">
	import { onDestroy } from 'svelte';
	import { createMutation } from '@tanstack/svelte-query';
	import { InferencePicker } from '@epicenter/app-shell/inference-picker';
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Field from '@epicenter/ui/field';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { resolveCompletionState } from '$lib/state/completion.svelte';
	import { resolveCompletionStateFromConfig, resolveTextDestination } from '$lib/operations/completion-target';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import { getWhisperingApp } from '$lib/whispering/context';

	const whispering = getWhisperingApp();
	const ai = whispering.inferenceConnections.ai;
	let alive = true;
	onDestroy(() => { alive = false; });
	const useSavedEndpoint = createMutation(() => ({
		mutationFn: async () => {
			if (!previous.target) throw new Error('Saved endpoint is unavailable.');
			const model = whispering.settings.get('completionModel').trim();
			const id = await ai.connections!.add({ ...previous.target, models: [model] });
			if (!alive || ai !== whispering.inferenceConnections.ai) return;
			whispering.inferenceConnections.selections.set('completion', { connectionId: id, model });
			whispering.settings.set('completionModel', model);
		},
	}));
	const state = $derived(resolveCompletionState());
	// Old provider fields are only an explicit setup source, never a routing fallback.
	const previous = $derived(resolveCompletionStateFromConfig({
		provider: whispering.settings.get('completionProvider'),
		getDeviceConfig: deviceConfig.get,
	}));
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
			then choose a model or enter its ID. Desktop connections are shared across apps on this device. Browser connections stay in this app’s local settings.
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
		{#if previous.target && previous.canRun && whispering.settings.get('completionModel').trim()}
			{@const target = previous.target}
			<Button variant="outline" disabled={useSavedEndpoint.isPending} onclick={() => useSavedEndpoint.mutate()}>
				Use saved endpoint: {whispering.settings.get('completionModel')} · {resolveTextDestination(whispering.settings.get('completionProvider'), target)}
			</Button>
		{/if}
	{/if}
	{#if useSavedEndpoint.isError}<p role="alert" class="text-sm text-destructive">Could not save the connection. Try again.</p>{/if}
</Field.Group>
