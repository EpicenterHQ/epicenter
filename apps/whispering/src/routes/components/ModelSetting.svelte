<script lang="ts">
	import type { ModelChoice } from '@epicenter/ai';
	import { ModelPicker } from '@epicenter/ai/picker';
	import { toast } from 'svelte-sonner';
	import { getWhispering } from '$lib/whispering.svelte.js';

	/**
	 * The transcription model: any model the merged endpoints offer that
	 * can transcribe (`ModelPicker` from `@epicenter/ai/picker`), where a person also
	 * adds, edits or removes a connection and its key. Choosing sends nothing;
	 * a request goes only when the person presses Transcribe.
	 */
	const whispering = getWhispering();
	const chosen = $derived(whispering.chosen());
	const choice = $derived(whispering.choice());

	async function select(next: ModelChoice) {
		const problem = await whispering.choose(next);
		if (problem) toast.error('Could not choose the transcription model', { description: problem });
	}
</script>

<div class="flex flex-col gap-2 text-sm" data-testid="model-transcription">
	<div class="flex items-center justify-between gap-2">
		<p class="font-medium">Transcription</p>
		<ModelPicker
			ai={whispering.ai}
			can="transcribe"
			value={choice}
			onSelect={select}
			placeholder="Choose a model"
		/>
	</div>
	<p class="text-xs text-muted-foreground" data-testid="model-transcription-status">
		{#if chosen.error === null}
			{chosen.data.model} at {chosen.data.name}.
		{:else if choice === null}
			Not chosen. Nothing is sent until you choose one.
		{:else}
			{chosen.error}
		{/if}
		Audio is sent there only when you press Transcribe.
	</p>
</div>
