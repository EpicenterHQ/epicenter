<script lang="ts">
	import { getWhispering } from '$lib/whispering.svelte.js';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import * as Empty from '@epicenter/ui/empty';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import WandSparklesIcon from '@lucide/svelte/icons/wand-sparkles';
	import { STARTER_TRANSFORMATIONS } from '$lib/definition.js';
	import type { TransformationEntry } from '$lib/library.svelte.js';
	import { recipeModel } from '$lib/recipe.js';
	import { openItem } from './file-actions.js';

	let { onOpen }: { onOpen?: () => void } = $props();
	const { library } = getWhispering();

	let creating = $state(false);

	/** Write one new transformation file. Nothing is created until a button here is pressed. */
	async function create(starter: { title: string; prompt: string }) {
		creating = true;
		try {
			const problem = await library.createTransformation(starter);
			if (problem) toast.error('Could not create the transformation', { description: problem });
			else onOpen?.();
		} finally {
			creating = false;
		}
	}

	function titleOf(entry: TransformationEntry) {
		const { title } = entry.row.fields;
		if (title.trim() !== '') return title;
		// An empty ID (`transformations/.md`) is a real address but not a readable label.
		return entry.stem === '' ? entry.path : entry.stem;
	}
</script>

{#snippet starters()}
	{#each STARTER_TRANSFORMATIONS as starter (starter.title)}
		<DropdownMenu.Item onSelect={() => void create(starter)} data-testid="create-starter">{starter.title}</DropdownMenu.Item>
	{/each}
	<DropdownMenu.Separator />
	<DropdownMenu.Item onSelect={() => void create({ title: 'New transformation', prompt: '' })} data-testid="create-blank">
		Empty transformation
	</DropdownMenu.Item>
{/snippet}

<section class="flex h-full min-h-0 flex-col" aria-label="Transformations">
	<div class="flex items-start gap-3 border-b px-3 py-3 sm:px-4">
		<SectionHeader.Root class="min-w-0 flex-1">
			<SectionHeader.Title level={1} class="text-lg">Transformations</SectionHeader.Title>
			<SectionHeader.Description class="text-xs">
				Instructions you apply to a transcript or to pasted text. Each saved result is a new file; the text it came from is never changed.
			</SectionHeader.Description>
		</SectionHeader.Root>
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button {...props} size="sm" disabled={creating} data-testid="create-transformation">
						{#if creating}<Spinner class="size-3.5" />{:else}<PlusIcon />{/if}
						New
						<ChevronDownIcon />
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end" class="min-w-48">
				<DropdownMenu.Label>Start from</DropdownMenu.Label>
				{@render starters()}
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	</div>

	{#if library.transformationsError}
		<p class="border-b bg-destructive/10 px-3 py-2 text-xs text-destructive" role="status">
			Could not read the transformations folder: {library.transformationsError}. Showing the last list that was read.
		</p>
	{/if}

	<ul class="min-h-0 flex-1 overflow-y-auto" aria-label="Saved transformations" data-testid="transformation-list">
		{#each library.transformations as entry (entry.path)}
			{@const selected = library.selectedTransformationPath === entry.path}
			{@const results = library.outputsOf(entry.stem).length + library.textOutputsOf(entry.stem).length}
			{@const model = recipeModel(entry.row.fields)}
			<li class="border-b text-sm {selected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/50'}">
				<button
					type="button"
					class="flex w-full min-w-0 flex-col gap-0.5 px-3 py-2 text-left sm:px-4"
					aria-current={selected ? 'true' : undefined}
					data-transformation={entry.path}
					onclick={async () => {
						if (await openItem(library, entry.path)) onOpen?.();
					}}
				>
					<span class="flex items-center gap-2">
						<span class="truncate font-medium">{titleOf(entry)}</span>
					</span>
					<span class="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
						<span>{model ?? 'The text connection’s model'}</span>
						{#if results > 0}<span>· {results} {results === 1 ? 'result' : 'results'}</span>{/if}
					</span>
				</button>
			</li>
		{:else}
			<li>
				<Empty.Root class="py-10">
					<Empty.Header>
						<Empty.Media variant="icon"><WandSparklesIcon /></Empty.Media>
						<Empty.Title>No transformations yet</Empty.Title>
						<Empty.Description>
							A transformation is a title and instructions saved as a file in <code class="font-mono">transformations/</code>.
							It runs with the text connection in Settings. Start from one of these and edit it, or write your own.
						</Empty.Description>
					</Empty.Header>
					<Empty.Content class="flex-row flex-wrap justify-center">
						{#each STARTER_TRANSFORMATIONS as starter (starter.title)}
							<Button variant="outline" size="sm" disabled={creating} onclick={() => void create(starter)}>{starter.title}</Button>
						{/each}
					</Empty.Content>
				</Empty.Root>
			</li>
		{/each}
	</ul>

	{#if library.transformationRepairs.length > 0}
		<div class="border-t bg-warning/10 px-3 py-2 text-xs">
			<p class="font-medium">Needs repair</p>
			<ul class="mt-1 space-y-0.5">
				{#each library.transformationRepairs as item (item.path)}
					<li>
						<button type="button" class="font-mono underline" onclick={async () => {
							if (await openItem(library, item.path)) onOpen?.();
						}}>{item.path}</button>: {item.reason}
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</section>
