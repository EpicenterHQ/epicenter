<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Command from '@epicenter/ui/command';
	import { useCombobox } from '@epicenter/ui/hooks';
	import * as Popover from '@epicenter/ui/popover';
	import { cn } from '@epicenter/ui/utils';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import { CAPTURE_SURFACE_OPTIONS } from '$lib/constants/audio';
	import { selectCaptureSurface } from '$lib/operations/recording.svelte.js';
	import { captureSurface } from '$lib/state/capture-surface.svelte';
	import { getWhisperingApp } from '$lib/whispering/context';

	const app = getWhisperingApp();

	let { class: className }: { class?: string } = $props();

	const combobox = useCombobox();

	const current = $derived(
		CAPTURE_SURFACE_OPTIONS.find(
			(surface) => surface.value === captureSurface.current(app),
		),
	);
</script>

<Popover.Root bind:open={combobox.open}>
	<Popover.Trigger bind:ref={combobox.triggerRef}>
		{#snippet child({ props })}
			<Button
				{...props}
				class={cn('relative', className)}
				tooltip={current
					? `Capture: ${current.label}`
					: 'Select capture surface'}
				role="combobox"
				aria-expanded={combobox.open}
				variant="ghost"
				size="icon"
			>
				<ChevronDown class="size-4" />
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content align="end" class="p-0 w-48">
		<Command.Root loop>
			<Command.List>
				<Command.Group>
					{#each CAPTURE_SURFACE_OPTIONS as surface (surface.value)}
						{@const isSelected = captureSurface.current(app) === surface.value}
						{@const SurfaceIcon = surface.Icon}
						<Command.Item
							value={surface.value}
							onSelect={async () => {
								combobox.closeAndFocusTrigger();
								await selectCaptureSurface(app, surface.value);
							}}
							class="flex items-center gap-2 px-2 py-2"
						>
							<CheckIcon
								class={cn('size-3.5 shrink-0', {
									'text-transparent': !isSelected,
								})}
							/>
							<SurfaceIcon class="size-4 shrink-0" />
							<span class="text-sm">{surface.label}</span>
						</Command.Item>
					{/each}
				</Command.Group>
			</Command.List>
		</Command.Root>
	</Popover.Content>
</Popover.Root>
