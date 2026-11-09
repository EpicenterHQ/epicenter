<script lang="ts">
	import type { ModelChoice } from '@epicenter/ai';
	import { ModelPicker } from '@epicenter/ai/picker';
	import { toast } from '@epicenter/ui/sonner';
	import { CAN, getWhispering, type Operation } from '$lib/whispering.svelte.js';

	/**
	 * The model one operation uses: any model the merged endpoints offer that
	 * can do it (`ModelPicker` from `@epicenter/ai/picker`), where a person also
	 * adds, edits or removes a connection and its key. Choosing sends nothing;
	 * a request goes only when the person presses Transcribe or Run.
	 */
	let { operation }: { operation: Operation } = $props();

	const whispering = getWhispering();
	const chosen = $derived(whispering.chosen(operation));
	const choice = $derived(whispering.choice(operation));

	const copy = {
		transcription: {
			title: 'Transcription',
			sends: 'Audio is sent there only when you press Transcribe.',
		},
		text: {
			title: 'Text',
			sends:
				'Transformations send their instructions and text there only when you press Run. A transformation may name its own model at the same endpoint.',
		},
	} as const;

	async function select(next: ModelChoice) {
		const problem = await whispering.choose(operation, next);
		if (problem) toast.error(`Could not choose the ${operation} model`, { description: problem });
	}
</script>

<div class="flex flex-col gap-2 text-sm" data-testid="model-{operation}">
	<div class="flex items-center justify-between gap-2">
		<p class="font-medium">{copy[operation].title}</p>
		<ModelPicker
			ai={whispering.ai}
			can={CAN[operation]}
			value={choice}
			onSelect={select}
			placeholder="Choose a model"
		/>
	</div>
	<p class="text-xs text-muted-foreground" data-testid="model-{operation}-status">
		{#if chosen.kind === 'ready'}
			{chosen.target.model} at {chosen.target.name}.
		{:else if choice === null}
			Not chosen. Nothing is sent until you choose one.
		{:else}
			{chosen.reason}
		{/if}
		{copy[operation].sends}
	</p>
</div>
