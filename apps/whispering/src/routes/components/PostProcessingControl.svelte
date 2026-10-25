<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Label } from '@epicenter/ui/label';
	import * as Popover from '@epicenter/ui/popover';
	import * as RadioGroup from '@epicenter/ui/radio-group';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import WandIcon from '@lucide/svelte/icons/wand';
	import { resolve } from '$app/paths';
	import { transformationName } from '$lib/post-processing.js';
	import { getWhispering } from '$lib/whispering.svelte.js';
	import { returnFocusToTrigger } from './option-popover-focus.js';

	/**
	 * Which saved transformation post-processing uses, or None. Choosing only
	 * chooses: nothing is sent until Run is pressed on a transcript. The list is
	 * the folder's transformations as last read, and a choice that was deleted
	 * or can no longer run is shown as that, not replaced. The recorder owns
	 * which option popover is open.
	 */
	let { open = $bindable(false) }: { open?: boolean } = $props();
	let trigger = $state<HTMLElement | null>(null);
	let content = $state<HTMLElement | null>(null);

	const whispering = getWhispering();
	const { view } = whispering;

	const choice = $derived(whispering.postProcessing);
	const name = $derived(
		choice.kind === 'none' ? 'None' : choice.kind === 'missing' ? 'Not in the folder' : transformationName(choice.entry),
	);

	/** The trigger is an icon, so this is its whole name: what it is, what is chosen, and what is wrong. */
	const summary = $derived(
		`Post-processing: ${name}${choice.kind === 'repair' ? `. It cannot run: ${choice.reason}` : choice.kind === 'missing' ? '. The chosen transformation was deleted or moved.' : ''}`,
	);
	let hinting = $state(false);

	// A row path always has a slash, so it never equals None's value.
	const NONE = 'none';
</script>

<Popover.Root bind:open>
	<!-- The hint is composed here, not through the button's own tooltip, so it can be held shut while the popover is open and never takes its Escape. -->
	<Tooltip.Root disabled={open} bind:open={() => hinting && !open, (next) => (hinting = next)}>
		<Tooltip.Trigger>
			{#snippet child({ props: hint })}
				<Popover.Trigger {...hint}>
					{#snippet child({ props })}
						<!--
							None is the amber wand: that is this control's own color, not a warning. A chosen transformation is sparkles,
							green when it can run. One that cannot, or is gone, stays shown as chosen, with a warning mark on it.
						-->
						<Button
							{...props}
							bind:ref={trigger}
							variant="ghost"
							size="icon"
							aria-label={summary}
							data-testid="post-processing-control"
						>
							{#if choice.kind === 'none'}
								<WandIcon class="text-warning" />
							{:else if choice.kind === 'ready'}
								<SparklesIcon class="text-success brightness-75 dark:brightness-100" />
							{:else}
								<span class="relative flex">
									<SparklesIcon class="text-muted-foreground" />
									<TriangleAlertIcon class="absolute -top-1.5 -right-1.5 size-3 fill-background text-warning" />
								</span>
							{/if}
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
		class="max-h-(--bits-popover-content-available-height) w-72 max-w-[calc(100vw-1rem)] gap-3 overflow-y-auto"
		data-testid="post-processing-popover"
	>
		<p class="font-medium" id="post-processing-heading">Post-processing</p>
		<p class="text-xs text-muted-foreground">
			Choosing sends nothing. It runs only when you press Run on a transcript.
		</p>

		<RadioGroup.Root
			value={view.postProcessing ?? NONE}
			onValueChange={(next) => (view.postProcessing = next === NONE ? undefined : next)}
			aria-labelledby="post-processing-heading"
			class="gap-2"
		>
			<div class="flex items-center gap-2">
				<RadioGroup.Item value={NONE} id="post-processing-none" />
				<Label for="post-processing-none" class="font-normal">None</Label>
			</div>
			{#each whispering.transformations as item, index (item.path)}
				{@const resolved = whispering.resolve(item.row)}
				{@const runnable = resolved.kind === 'ready'}
				<!-- The group is a grid, so a row shrinks to the popover only with min-w-0; the label then takes what the radio leaves and the title truncates in it. -->
				<div class="flex min-w-0 items-center gap-2">
					<!-- One that cannot run is not offered, but stays shown as chosen if it already is. -->
					<RadioGroup.Item value={item.path} id="post-processing-{index}" disabled={!runnable && view.postProcessing !== item.path} />
					<Label for="post-processing-{index}" class="min-w-0 flex-1 font-normal">
						<span class="min-w-0 truncate" title={transformationName(item)}>{transformationName(item)}</span>
						{#if resolved.kind === 'blocked'}
							<Badge variant={resolved.fix === 'recipe' ? 'destructive' : 'outline'} class="shrink-0" title={resolved.reason}>
								{resolved.fix === 'recipe' ? 'Needs repair' : 'Not set up'}
							</Badge>
						{/if}
					</Label>
				</div>
			{/each}
			{#if choice.kind === 'missing'}
				<div class="flex min-w-0 items-center gap-2" data-testid="post-processing-missing">
					<RadioGroup.Item value={choice.path} id="post-processing-missing" />
					<Label for="post-processing-missing" class="min-w-0 flex-1 font-normal">
						<code class="min-w-0 truncate font-mono text-xs" title={choice.path}>{choice.path}</code>
						<span class="shrink-0 text-xs text-warning">no longer in the folder</span>
					</Label>
				</div>
			{/if}
		</RadioGroup.Root>

		{#if whispering.transformations.length === 0}
			<p class="text-xs text-muted-foreground" data-testid="post-processing-empty">
				This folder has no transformations yet. Create one to choose it here.
			</p>
		{/if}
		{#if whispering.transformationRepairs.length > 0}
			<p class="text-xs text-warning" role="status">
				{whispering.transformationRepairs.length === 1
					? '1 file in transformations/ needs repair and is not listed.'
					: `${whispering.transformationRepairs.length} files in transformations/ need repair and are not listed.`}
			</p>
		{/if}
		{#if choice.kind === 'repair'}
			<p class="text-xs text-warning" role="status">“{name}” cannot run: {choice.reason}</p>
		{:else if choice.kind === 'missing'}
			<p class="text-xs text-warning" role="status">The chosen transformation was deleted or moved. Choose another, or None.</p>
		{/if}

		<Button variant="outline" size="sm" href={resolve('/transformations')} data-testid="manage-transformations">
			Manage transformations
		</Button>
	</Popover.Content>
</Popover.Root>
