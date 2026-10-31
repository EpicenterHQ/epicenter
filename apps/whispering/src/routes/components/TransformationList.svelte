<script lang="ts">
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
	import { getWhispering } from '$lib/whispering.svelte.js';
	import { recipeModel, STARTER_TRANSFORMATIONS } from '$lib/recipe.js';
	import { titleOf } from './file-actions.js';
	import NoteRepair from './NoteRepair.svelte';

	let { onOpen }: { onOpen?: () => void } = $props();
	const whispering = getWhispering();

	let creating = $state(false);

	/** Make one new transformation. Nothing is created until a button here is pressed. */
	async function create(starter: { title: string; prompt: string }) {
		creating = true;
		try {
			const problem = await whispering.createTransformation(starter);
			if (problem === undefined) onOpen?.();
			else toast.error('Could not create the transformation', { description: problem });
		} finally {
			creating = false;
		}
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
				Instructions you apply to a transcript or to pasted text. Each saved result is a new note; the text it came from is never changed.
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

	<ul class="min-h-0 flex-1 overflow-y-auto" aria-label="Saved transformations" data-testid="transformation-list">
		{#each whispering.transformations as entry (entry.id)}
			{@const selected = whispering.selectedTransformationId === entry.id}
			{@const results = whispering.outputsOf(entry.id).length + whispering.textOutputsOf(entry.id).length}
			{@const model = recipeModel(entry)}
			<li class="border-b text-sm {selected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/50'}">
				<button
					type="button"
					class="flex w-full min-w-0 flex-col gap-0.5 px-3 py-2 text-left sm:px-4"
					aria-current={selected ? 'true' : undefined}
					data-transformation={entry.id}
					onclick={() => {
						if (whispering.openTransformation(entry.id)) onOpen?.();
					}}
				>
					<span class="flex items-center gap-2">
						<span class="truncate font-medium">{titleOf(entry)}</span>
						{#if entry.where === 'device' && whispering.signedIn}<Badge variant="outline">Not uploaded yet</Badge>{/if}
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
							A transformation is a title and instructions saved as a note in <code class="font-mono">transformations/</code>.
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

	{#if whispering.transformationRepairs.length + whispering.textRepairs.length > 0}
		<div class="max-h-[50%] overflow-y-auto border-t bg-warning/10 px-3 py-2 text-xs" data-testid="transformation-repairs">
			<p class="mb-2 font-medium">Needs repair</p>
			<div class="flex flex-col gap-4">
				{#each [...whispering.transformationRepairs, ...whispering.textRepairs] as repair (repair.path)}
					<NoteRepair {repair} />
				{/each}
			</div>
		</div>
	{/if}
</section>
