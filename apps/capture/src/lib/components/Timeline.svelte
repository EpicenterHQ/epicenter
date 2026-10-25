<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import * as Item from '@epicenter/ui/item';
	import { type Captures } from '$lib/captures.svelte.js';
	import { getFolder } from '$lib/folder.js';
	import NewCapture from './NewCapture.svelte';

	let { captures }: { captures: Captures } = $props();

	const folder = getFolder();
	const timeline = $derived(captures.timeline.rows);
	const drafts = $derived(captures.timeline.drafts);
	const repairs = $derived(captures.timeline.repairs);
	const unreadable = $derived(captures.timeline.unreadable);
	const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
</script>

<h1 class="mb-4 text-lg font-semibold tracking-tight">Timeline</h1>

<div class="mb-6">
	<NewCapture {captures} />
</div>

{#if drafts.length}
	<section class="mb-6" aria-label="Draft captures">
		<h2 class="mb-2 font-medium">Drafts</h2>
		<Item.Group class="gap-1">
			{#each drafts as row (row.path)}
				<Item.Button size="sm" class="w-full text-left hover:bg-muted" onclick={() => captures.open(row.stem, 'text')}>
					<Item.Content>
						<Item.Title class="line-clamp-2 whitespace-pre-line break-words">{row.preview || 'Empty draft'}</Item.Title>
						<Item.Description>Continue writing</Item.Description>
					</Item.Content>
				</Item.Button>
			{/each}
		</Item.Group>
	</section>
{/if}

{#if timeline.length}
	<Item.Group aria-label="Timeline captures" class="gap-1">
		{#each timeline as row (row.path)}
			<Item.Button size="sm" class="w-full text-left hover:bg-muted" onclick={() => captures.open(row.stem, 'capture')}>
				<Item.Content>
					<Item.Title class={['line-clamp-2 whitespace-pre-line break-words', !row.preview && 'text-muted-foreground']}>{row.preview || 'Empty capture'}</Item.Title>
					<Item.Description class="text-xs">
						{#if row.capturedAt}
							<time datetime={row.capturedAt.toISOString()}>{when.format(row.capturedAt)}</time>
						{:else}
							No capture date
						{/if}
						{#if row.thoughtCount > 0} · {row.thoughtCount} {row.thoughtCount === 1 ? 'thought' : 'thoughts'}{/if}
					</Item.Description>
				</Item.Content>
			</Item.Button>
		{/each}
	</Item.Group>
{:else if drafts.length === 0}
	<Empty.Root>
		<Empty.Header>
			<Empty.Title>No captures yet</Empty.Title>
			<Empty.Description>Write or paste something above to keep it. Each capture is one Markdown file, and you can add thoughts to it later.</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{/if}

{#if repairs.length}
	<!-- Not offered as captures: each opens as text, where it can be repaired. -->
	<Alert.Root variant="destructive" aria-label="Files to repair" class="mt-6">
		<Alert.Title>{repairs.length} {repairs.length === 1 ? 'file does' : 'files do'} not read as a capture</Alert.Title>
		<Alert.Description>They are not listed above, and nothing in them was changed. Edit one as text to repair it.</Alert.Description>
		<ul class="mt-2 flex flex-col gap-2 text-foreground">
			{#each repairs as row (row.path)}
				<li class="flex flex-wrap items-start gap-2">
					<p class="min-w-0 flex-1 break-words"><code class="break-all">{row.path}</code>: {row.problem}</p>
					<Button size="sm" variant="outline" aria-label="Edit {row.path} as text" onclick={() => captures.open(row.stem, 'text')}>Edit as text</Button>
				</li>
			{/each}
		</ul>
	</Alert.Root>
{/if}

{#if unreadable.length}
	<Alert.Root variant="destructive" aria-label="Unreadable files" class="mt-6">
		<Alert.Title>{unreadable.length} {unreadable.length === 1 ? 'file' : 'files'} could not be read</Alert.Title>
		<Alert.Description>These files are kept as they are, untouched.</Alert.Description>
		<ul class="mt-1 flex flex-col gap-2 text-foreground">
			{#each unreadable as file (file.path)}
				<li class="flex flex-wrap items-start gap-2 break-words"><span><code>{file.path}</code>: {file.message}</span>{#if file.retry}<Button size="sm" variant="outline" onclick={() => folder.checkpoint()}>Try again</Button>{/if}</li>
			{/each}
		</ul>
	</Alert.Root>
{/if}

<footer class="mt-10 border-t pt-4 text-xs text-muted-foreground">
	<p>Captures are kept on this device, each as a Markdown file in <code>captures</code>. They are not synced to other devices.</p>
</footer>
