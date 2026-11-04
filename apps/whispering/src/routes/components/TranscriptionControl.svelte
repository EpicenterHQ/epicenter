<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Popover from '@epicenter/ui/popover';
	import * as Tooltip from '@epicenter/ui/tooltip';
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
	let hinting = $state(false);
</script>

<Popover.Root bind:open>
	<!-- The hint is composed here, not through the button's own tooltip, so it can be held shut while the popover is open and never takes its Escape. -->
	<Tooltip.Root disabled={open} bind:open={() => hinting && !open, (next) => (hinting = next)}>
		<Tooltip.Trigger>
			{#snippet child({ props: hint })}
				<Popover.Trigger {...hint}>
					{#snippet child({ props })}
						<Button
							{...props}
							bind:ref={trigger}
							variant="ghost"
							size="icon"
							aria-label={summary}
							data-testid="transcription-control"
						>
							<AudioLinesIcon class={ready ? 'text-success brightness-75 dark:brightness-100' : 'text-warning'} />
						</Button>
					{/snippet}
				</Popover.Trigger>
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Content side="bottom" class="max-w-xs text-center">{summary}</Tooltip.Content>
	</Tooltip.Root>
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
