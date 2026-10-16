<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Popover from '@epicenter/ui/popover';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import AudioLinesIcon from '@lucide/svelte/icons/audio-lines';
	import { getSession } from '$lib/session.svelte.js';
	import { returnFocusToTrigger } from './option-popover-focus.js';
	import SettingsForm from './SettingsForm.svelte';

	/**
	 * The transcription connection in use, beside the recorder. It opens the
	 * choice of it from the header's Settings. The model is the connection's:
	 * an endpoint is never asked what it serves. The recorder owns which
	 * option popover is open.
	 */
	let { open = $bindable(false) }: { open?: boolean } = $props();
	let trigger = $state<HTMLElement | null>(null);
	let content = $state<HTMLElement | null>(null);

	const { library } = getSession();
	const connection = $derived(library.connections.transcription);
	const summary = $derived(
		connection?.unusable ??
			(connection
				? `Transcribes with ${connection.kind === 'local' && !connection.model ? 'the active local model' : connection.model} over ${connection.title}`
				: 'Transcription is not set up. Choose its connection to transcribe.'),
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
							<AudioLinesIcon class={connection && !connection.unusable ? 'text-success brightness-75 dark:brightness-100' : 'text-warning'} />
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
