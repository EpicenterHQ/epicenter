<script lang="ts">
	import { IconButton } from '@epicenter/ui/icon-button';
	import * as Popover from '@epicenter/ui/popover';
	import AudioLinesIcon from '@lucide/svelte/icons/audio-lines';
	import { getWhispering } from '$lib/whispering.svelte.js';
	import { returnFocusToTrigger } from './option-popover-focus.js';
	import SettingsForm from './SettingsForm.svelte';

	/**
	 * The transcription model in use, beside the recorder. It opens the
	 * transcription part of the header's settings, the same choice. The
	 * recorder owns which option popover is open.
	 */
	let { open = $bindable(false) }: { open?: boolean } = $props();
	let trigger = $state<HTMLElement | null>(null);
	let content = $state<HTMLElement | null>(null);

	const whispering = getWhispering();
	const chosen = $derived(whispering.chosen('transcription'));
	const ready = $derived(chosen.kind === 'ready');
	const summary = $derived(
		chosen.kind === 'ready'
			? `Transcription model: ${chosen.target.model}, at ${chosen.target.name}`
			: 'No transcription model is chosen. Choose one to transcribe.',
	);
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<IconButton
				label={summary}
				{...props}
				bind:ref={trigger}
				variant="ghost"
				data-testid="transcription-control"
			>
				<AudioLinesIcon class={ready ? 'text-success brightness-75 dark:brightness-100' : 'text-warning'} />
			</IconButton>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content
		bind:ref={content}
		onCloseAutoFocus={(event) => returnFocusToTrigger(event, trigger, content)}
		side="bottom"
		collisionPadding={8}
		class="max-h-(--bits-popover-content-available-height) w-80 max-w-[calc(100vw-1rem)] overflow-y-auto"
		data-testid="transcription-popover"
	>
		<SettingsForm only="transcription" />
	</Popover.Content>
</Popover.Root>
