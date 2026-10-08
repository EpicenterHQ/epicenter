<script lang="ts">
	import * as Command from '../command/index.js';
	import { confirmationDialog } from '../confirmation-dialog/index.js';
	import type { CommandPaletteItem } from './index.js';

	let {
		items,
		open: isOpen = $bindable(false),
		value = $bindable(''),
		placeholder = 'Search commands...',
		emptyMessage = 'No commands found.',
		title = 'Command Palette',
		description = 'Search for a command to run',
		shouldFilter,
		shortcut = 'k',
	}: {
		items: CommandPaletteItem[];
		open: boolean;
		/** Bindable search input value. Use with `shouldFilter={false}` for custom filtering. */
		value?: string;
		placeholder?: string;
		emptyMessage?: string;
		title?: string;
		description?: string;
		/** Set `false` to manage filtering yourself (e.g. debounced async search). */
		shouldFilter?: boolean;
		/**
		 * Keyboard shortcut key that toggles the palette when pressed with Cmd (macOS) or Ctrl.
		 *
		 * Defaults to `'k'` (Cmd+K / Ctrl+K). Set to `null` to disable the built-in
		 * shortcut entirely\u2014useful when the parent manages open state via a custom trigger
		 * (e.g. a button click or a different key combo).
		 *
		 * @example
		 * ```svelte
		 * <!-- Default Cmd+K -->
		 * <CommandPalette {items} />
		 *
		 * <!-- Disable shortcut, parent controls open -->
		 * <CommandPalette {items} shortcut={null} bind:open />
		 * ```
		 */
		shortcut?: string | null;
	} = $props();

	// \u2500\u2500 Reset search value when palette closes \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	$effect(() => {
		if (!isOpen) value = '';
	});

	// \u2500\u2500 Group items by the `group` field \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	const grouped = $derived(Map.groupBy(items, (item) => item.group));

	function sanitizeSnippet(html: string): string {
		return html.replace(/<(?!\/?mark\b)[^>]*>/gi, '');
	}
</script>

<svelte:window
	onkeydown={(e) => {
		if (shortcut && (e.metaKey || e.ctrlKey) && e.key === shortcut) {
			e.preventDefault();
			isOpen = !isOpen;
		}
	}}
/>

<Command.Dialog bind:open={isOpen} {title} {description} {shouldFilter}>
	<Command.Input {placeholder} bind:value />
	<Command.List>
		<Command.Empty>{emptyMessage}</Command.Empty>
		{#each grouped as [ group, groupItems ]}
			<Command.Group heading={group}>
				{#each groupItems as item (item.id)}
					<Command.Item
						value={item.label}
						keywords={item.keywords}
						onSelect={() => {
							isOpen = false;
							if (item.destructive) {
								confirmationDialog.open({
									title: item.label,
									description: item.description ?? 'Are you sure?',
									confirm: { text: 'Confirm', variant: 'destructive' },
									onConfirm: () => item.onSelect(),
								});
							} else {
								item.onSelect();
							}
						}}
					>
						{#if item.icon}
							{@const Icon = item.icon}
							<Icon class="size-4" />
						{/if}
						<div class="flex flex-col">
							<span>{item.label}</span>
							{#if item.description}
								<span class="text-xs text-muted-foreground">
									{item.description}
								</span>
							{/if}
							{#if item.snippet}
								<span
									class="snippet line-clamp-2 text-xs text-muted-foreground/70"
								>
									{@html sanitizeSnippet(item.snippet)}
								</span>
							{/if}
						</div>
					</Command.Item>
				{/each}
			</Command.Group>
		{/each}
	</Command.List>
</Command.Dialog>

<style>
	.snippet :global(mark) {
		background-color: hsl(var(--primary) / 0.2);
		color: inherit;
		border-radius: 2px;
		padding: 0 1px;
	}
</style>
