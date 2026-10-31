<!--
	The timeline of one view's captures: New capture, then every capture
	newest first, then the files at a capture's path that open as text to
	repair, and those that are not text.
-->
<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import * as Item from '@epicenter/ui/item';
	import { Loading } from '@epicenter/ui/loading';
	import { folder } from '#platform/folder';
	import type { Captures } from '$lib/captures.svelte.js';
	import NewCapture from './NewCapture.svelte';

	let { captures }: { captures: Captures } = $props();

	const timeline = $derived(captures.timeline.rows);
	const repairs = $derived(captures.timeline.repairs);
	const notText = $derived(captures.timeline.notText);
	const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
</script>

<h1 class="mb-4 text-lg font-semibold tracking-tight">Timeline</h1>

<div class="mb-6">
	<NewCapture {captures} />
</div>

{#if timeline.length}
	<Item.Group aria-label="Timeline captures" class="gap-1">
		{#each timeline as row (row.id)}
			<Item.Button
				size="sm"
				class="w-full text-left hover:bg-muted"
				data-id={row.id}
				onclick={() => captures.open(row.id, 'capture')}
			>
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
{:else if captures.list.loading}
	<Loading class="py-12" label="Opening captures…" />
{:else}
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
			{#each repairs as file (file.path)}
				<li class="flex flex-wrap items-start gap-2">
					<p class="min-w-0 flex-1 break-words"><code class="break-all">{file.path}</code>: {file.problem}</p>
					<Button size="sm" variant="outline" aria-label="Edit {file.path} as text" onclick={() => captures.open(file.id, 'text')}>Edit as text</Button>
				</li>
			{/each}
		</ul>
	</Alert.Root>
{/if}

{#if notText.length}
	<Alert.Root variant="destructive" aria-label="Files that are not text" class="mt-6">
		<Alert.Title>{notText.length} {notText.length === 1 ? 'file is' : 'files are'} not text</Alert.Title>
		<Alert.Description>They are kept as they are, untouched.</Alert.Description>
		<ul class="mt-1 flex flex-col gap-1 text-foreground">
			{#each notText as file (file.path)}
				<li class="break-all"><code>{file.path}</code></li>
			{/each}
		</ul>
	</Alert.Root>
{/if}

<footer class="mt-10 border-t pt-4 text-xs text-muted-foreground">
	{#if captures.view === 'synced'}
		<p>These captures are kept in your Epicenter repository, each as a Markdown file in <code>captures</code>.</p>
	{:else if folder !== null}
		<p>These captures are kept in Capture's folder on this computer, each as a Markdown file in <code>captures</code>.</p>
	{:else}
		<p>These captures are kept in this browser, each as a Markdown file in <code>captures</code>. Signed in, they upload to your Epicenter repository on their own and are then under Synced.</p>
	{/if}
</footer>
