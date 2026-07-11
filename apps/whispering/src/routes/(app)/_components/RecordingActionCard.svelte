<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Kbd from '@epicenter/ui/kbd';
	import { Spinner } from '@epicenter/ui/spinner';
	import { cn } from '@epicenter/ui/utils';
	import type { Snippet } from 'svelte';
	import type { RecordingActionController } from './recording-action-controller';

	// The controller owns the state machine and every derived label/icon. The card
	// only decides presentation: a spinner while pending, the destructive "filled"
	// treatment while active, and the pipeline footer below the toggle.
	let {
		controller,
		footer,
		iconViewTransitionName,
	}: {
		controller: RecordingActionController;
		footer?: Snippet;
		/**
		 * When set, names the action glyph for a cross-page view transition while
		 * the card is at rest. Suppressed automatically while `active`, because the
		 * live glyph (a stop square) is a different object and must not morph from
		 * the resting mode glyph. Callers pass the name unconditionally; the card
		 * owns the at-rest gate.
		 */
		iconViewTransitionName?: string;
	} = $props();

	const accessibleLabel = $derived(
		controller.shortcutLabel
			? `${controller.label} (${controller.shortcutLabel})`
			: controller.label,
	);
</script>

<div
	class={cn(
		'w-full overflow-hidden rounded-xl bg-card text-foreground shadow-sm transition-[box-shadow] duration-200',
		controller.active && 'shadow-md ring-1 ring-destructive/25',
	)}
>
	<Button
		aria-label={accessibleLabel}
		aria-pressed={controller.active}
		aria-busy={controller.pending}
		tooltip={controller.tooltip}
		disabled={controller.pending}
		onclick={controller.toggle}
		variant="ghost"
		class={cn(
			'h-auto min-h-24 w-full items-center justify-start gap-3 rounded-none bg-transparent px-5 py-6 text-left hover:bg-transparent dark:hover:bg-transparent sm:gap-4',
			controller.pending && 'cursor-wait',
		)}
	>
		<!-- The controller owns the state machine and the icon (mic -> stop square);
		this glyph only paints it. The floating pill, not this card, is the live
		recording surface on every platform and route, so the glyph never animates
		or meters: it is a static recording-accent CTA that turns tinted destructive
		while active. -->
		<span
			aria-hidden="true"
			class={cn(
				'relative flex size-14 shrink-0 items-center justify-center rounded-lg shadow-sm transition-colors duration-200 sm:size-16',
				controller.active
					? 'bg-destructive/10 text-destructive'
					: 'bg-(--recording-accent) text-(--recording-accent-foreground)',
			)}
		>
			{#if controller.pending}
				<Spinner class="size-7" />
			{:else}
				{@const Icon = controller.icon}
				<span
					class="inline-flex"
					style:view-transition-name={controller.active
						? undefined
						: iconViewTransitionName}
				>
					<Icon
						class={cn(
							'size-7',
							controller.active && 'size-6 fill-current stroke-[1.75]',
						)}
					/>
				</span>
			{/if}
		</span>
		<span class="flex min-w-0 flex-1 flex-col gap-1">
			<span class="truncate text-base font-semibold leading-none sm:text-lg">
				{controller.label}
			</span>
			<span class="truncate text-xs font-medium text-muted-foreground sm:text-sm">
				{controller.description}
			</span>
		</span>
		{#if controller.shortcutLabel}
			<Kbd.Root
				class="h-7 max-w-28 shrink-0 rounded-md bg-muted/75 px-2 text-xs text-muted-foreground shadow-none"
			>
				{controller.shortcutLabel}
			</Kbd.Root>
		{/if}
	</Button>

	<!-- The footer stays put across start/stop, so there is no height jump by
	construction. Cancel lives on the pill, the sole live recording surface. The
	pipeline controls stay useful mid-take: model and transformation are read at
	stop time. -->
	{#if footer}
		<div class="border-t border-border/60 px-5 pt-3 pb-5">
			{@render footer()}
		</div>
	{/if}
</div>
