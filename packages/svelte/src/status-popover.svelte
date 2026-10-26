<!--
	The status a folder app shows in its header: a button with the one summary
	line and its tone, and details that name each fact on its own line. The app
	words every line (`@epicenter/svelte/status-line`); its own rows go in as
	`StatusRow` children after the lines, and its actions in `footer`.

	```svelte
	<StatusPopover {summary} details={[{ name: 'Files', testid: 'status-files', line: files }]}>
		<StatusRow name="Folder" data-testid="status-folder">{location}</StatusRow>
		{#snippet footer()}<Button size="sm" onclick={saveVersion}>Save version</Button>{/snippet}
	</StatusPopover>
	```

-->
<script module lang="ts">
	import type { StatusLine, Tone } from './status-line.js';

	/** One fact the details name: its row name, its test id, and its line. */
	export type StatusDetail = {
		readonly name: string;
		readonly testid: string;
		readonly line: StatusLine;
	};

	const DOT: Record<Tone, string> = {
		neutral: 'bg-muted-foreground/50',
		busy: 'bg-primary animate-pulse',
		good: 'bg-success',
		warning: 'bg-warning',
		error: 'bg-destructive',
	};

</script>

<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import * as Popover from '@epicenter/ui/popover';
	import type { Snippet } from 'svelte';
	import StatusRow from './status-row.svelte';

	let {
		summary,
		details,
		open = $bindable(false),
		children,
		footer,
	}: {
		/** The one line the button shows. */
		summary: StatusLine;
		/** The facts the details name, in order. */
		details: readonly StatusDetail[];
		/** Whether the details show, for an app that reads something while they do. */
		open?: boolean;
		/** The app's own `StatusRow`s, after the lines. */
		children?: Snippet;
		/** The app's actions, under the rows. */
		footer?: Snippet;
	} = $props();
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				variant="ghost"
				size="sm"
				class="min-w-0 shrink font-normal text-muted-foreground"
				aria-label="Status: {summary.label}. Show details"
				data-testid="status-summary"
			>
				<span class="size-2 shrink-0 rounded-full {DOT[summary.tone]}" aria-hidden="true"></span>
				<span class="truncate sm:hidden">{summary.short ?? summary.label}</span>
				<span class="truncate max-sm:hidden">{summary.label}</span>
				<ChevronDownIcon class="text-muted-foreground max-sm:hidden" aria-hidden="true" />
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content align="start" class="w-96 max-w-[calc(100vw-1rem)] p-0">
		<dl class="divide-y text-sm">
			{#each details as { name, testid, line } (name)}
				<StatusRow {name}>
					<span class="flex items-center gap-1.5 font-medium" data-testid={testid}>
						<span class="size-2 shrink-0 rounded-full {DOT[line.tone]}" aria-hidden="true"></span>
						{line.label}
					</span>
					{#if line.detail}
						<span class="mt-0.5 block text-xs break-words whitespace-pre-line text-muted-foreground">{line.detail}</span>
					{/if}
				</StatusRow>
			{/each}
			{@render children?.()}
		</dl>
		{#if footer}
			<div class="flex items-center gap-2 border-t px-3 py-2">
				{@render footer()}
			</div>
		{/if}
	</Popover.Content>
</Popover.Root>
