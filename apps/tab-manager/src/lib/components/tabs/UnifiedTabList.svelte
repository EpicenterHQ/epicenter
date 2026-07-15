<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import * as Item from '@epicenter/ui/item';
	import { toast } from '@epicenter/ui/sonner';
	import { cn } from '@epicenter/ui/utils';
	import AppWindowIcon from '@lucide/svelte/icons/app-window';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import SearchIcon from '@lucide/svelte/icons/search';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { VList } from 'virtua/svelte';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { tabManagerBoot } from '$lib/session.svelte';
	import { browserState } from '$lib/state/browser-state.svelte';
	import { getDomain, getRelativeTime } from '$lib/utils/format';
	import TabFavicon from './TabFavicon.svelte';
	import TabItem from './TabItem.svelte';

	const tabManager = tabManagerBoot.tabManager;

	function reportFailure(title: string, error: unknown) {
		toast.error(title, { description: extractErrorMessage(error) });
	}
</script>

{#if tabManager.state.view.isFiltering && tabManager.state.view.flatItems.every((item) => item.kind === 'section-header')}
	<Empty.Root class="py-8">
		<Empty.Media><SearchIcon class="size-8 text-muted-foreground" /></Empty.Media>
		<Empty.Title>No matching tabs or captures</Empty.Title>
		<Empty.Description>
			Nothing matches "{tabManager.state.view.searchQuery}".
		</Empty.Description>
	</Empty.Root>
{:else}
	<VList
		data={tabManager.state.view.flatItems}
		style="height: 100%;"
		getKey={(item) => {
			switch (item.kind) {
				case 'section-header': return `section-${item.section}`;
				case 'window-header': return `window-${item.window.id}`;
				case 'tab': return `tab-${item.tab.id}`;
				case 'capture': return `capture-${item.capture.id}`;
			}
		}}
	>
		{#snippet children(item)}
			{#if item.kind === 'section-header'}
				{@const isExpanded = tabManager.state.view.isFiltering || tabManager.state.view.isSectionExpanded(item.section)}
				<button
					type="button"
					disabled={tabManager.state.view.isFiltering}
					onclick={() => tabManager.state.view.toggleSection(item.section)}
					class="sticky top-0 z-20 flex w-full items-center gap-2 border-b bg-background px-4 py-2.5 text-sm font-medium enabled:hover:bg-accent"
				>
					<ChevronRightIcon class={cn('size-4 text-muted-foreground transition', isExpanded && 'rotate-90')} />
					<span>{item.label}</span>
					<Badge variant="outline" class="ml-auto">{item.count}</Badge>
				</button>
			{:else if item.kind === 'window-header'}
				{@const windowTabs = browserState.tabsByWindow(item.window.id)}
				{@const label = windowTabs.find((tab) => tab.active)?.title ?? windowTabs.at(0)?.title ?? 'Window'}
				<div class="sticky top-0 z-10 flex items-center gap-2 border-b bg-muted/50 px-4 py-2 text-sm text-muted-foreground backdrop-blur">
					<AppWindowIcon class="size-4" />
					<span class="truncate">{label}</span>
					{#if item.window.focused}<Badge variant="secondary" class="ml-auto">focused</Badge>{/if}
					<Badge variant="outline" class={item.window.focused ? undefined : 'ml-auto'}>{windowTabs.length}</Badge>
				</div>
			{:else if item.kind === 'tab'}
				<div class="border-b"><TabItem tab={item.tab} /></div>
			{:else if item.kind === 'capture'}
				<div class="border-b">
					<Item.Root size="sm" class="hover:bg-accent/50">
						<Item.Media><TabFavicon src={item.capture.favIconUrl} /></Item.Media>
						<Item.Content>
							<Item.Title><span class="truncate">{item.capture.title || 'Untitled'}</span></Item.Title>
							<Item.Description class="flex min-w-0 items-center gap-2 truncate">
								<span class="truncate">{getDomain(item.capture.url)}</span>
								<span aria-hidden="true">·</span>
								<span class="shrink-0">{getRelativeTime(item.capture.capturedAt)}</span>
							</Item.Description>
						</Item.Content>
						<Item.Actions showOnHover class="gap-1">
							<Button
								variant="ghost"
								size="icon-xs"
								tooltip="Open and remove from inbox"
								disabled={tabManager.state.captures.isPending(item.capture.id)}
								onclick={() => void tabManager.state.captures.open(item.capture).catch((error) => reportFailure('Failed to open capture', error))}
							>
								<ExternalLinkIcon />
							</Button>
							<Button
								variant="ghost"
								size="icon-xs"
								class="text-destructive"
								tooltip="Discard"
								disabled={tabManager.state.captures.isPending(item.capture.id)}
								onclick={() => void tabManager.state.captures.discard(item.capture).catch((error) => reportFailure('Failed to discard capture', error))}
							>
								<Trash2Icon />
							</Button>
						</Item.Actions>
					</Item.Root>
				</div>
			{/if}
		{/snippet}
	</VList>
{/if}
