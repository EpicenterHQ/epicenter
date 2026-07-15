<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Item from '@epicenter/ui/item';
	import { toast } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { cn } from '@epicenter/ui/utils';
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import PinIcon from '@lucide/svelte/icons/pin';
	import PinOffIcon from '@lucide/svelte/icons/pin-off';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import Volume2Icon from '@lucide/svelte/icons/volume-2';
	import VolumeXIcon from '@lucide/svelte/icons/volume-x';
	import XIcon from '@lucide/svelte/icons/x';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { tabManagerBoot } from '$lib/session.svelte';
	import { type BrowserTab, browserState } from '$lib/state/browser-state.svelte';
	import { getDomain } from '$lib/utils/format';
	import TabFavicon from './TabFavicon.svelte';

	const tabManager = tabManagerBoot.tabManager;
	let { tab }: { tab: BrowserTab } = $props();
	const domain = $derived(tab.url ? getDomain(tab.url) : '');
</script>

<Item.Root size="sm" class={cn('w-full text-left', tab.active ? 'bg-accent/50' : 'hover:bg-accent')}>
	<Item.Media><TabFavicon src={tab.favIconUrl} /></Item.Media>
	<Item.Content>
		<Item.Title>
			{#if tab.pinned}<PinIcon class="size-3 text-muted-foreground" />{/if}
			{#if tab.audible && !tab.mutedInfo?.muted}<Volume2Icon class="size-3 text-muted-foreground" />{/if}
			{#if tab.mutedInfo?.muted}<VolumeXIcon class="size-3 text-muted-foreground" />{/if}
			<button
				type="button"
				class="truncate rounded-sm text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				onclick={() => browserState.activate(tab.id)}
			>
				{tab.title || 'Untitled'}
			</button>
		</Item.Title>
		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props }: { props: Record<string, unknown> })}
					<Item.Description {...props} class="w-fit truncate">{domain}</Item.Description>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Content side="bottom" collisionPadding={8} class="max-w-[calc(100vw-2rem)] break-all">{tab.url}</Tooltip.Content>
		</Tooltip.Root>
	</Item.Content>
	<Item.Actions showOnHover class="gap-1">
				<Button
					variant="ghost"
					size="icon-xs"
					tooltip={tab.pinned ? 'Unpin' : 'Pin'}
					onclick={(event: MouseEvent) => {
						event.stopPropagation();
						void (tab.pinned ? browserState.unpin(tab.id) : browserState.pin(tab.id));
					}}
				>
					{#if tab.pinned}<PinOffIcon />{:else}<PinIcon />{/if}
				</Button>
				{#if tab.audible || tab.mutedInfo?.muted}
					<Button
						variant="ghost"
						size="icon-xs"
						tooltip={tab.mutedInfo?.muted ? 'Unmute' : 'Mute'}
						onclick={(event: MouseEvent) => {
							event.stopPropagation();
							void (tab.mutedInfo?.muted ? browserState.unmute(tab.id) : browserState.mute(tab.id));
						}}
					>
						{#if tab.mutedInfo?.muted}<Volume2Icon />{:else}<VolumeXIcon />{/if}
					</Button>
				{/if}
				<Button variant="ghost" size="icon-xs" tooltip="Reload" onclick={(event: MouseEvent) => { event.stopPropagation(); void browserState.reload(tab.id); }}><RefreshCwIcon /></Button>
				<Button variant="ghost" size="icon-xs" tooltip="Duplicate" onclick={(event: MouseEvent) => { event.stopPropagation(); void browserState.duplicate(tab.id); }}><CopyIcon /></Button>
				<Button
					variant="ghost"
					size="icon-xs"
					tooltip="Capture for later"
					disabled={tabManager.state.captures.isCapturing(tab.id)}
					onclick={(event: MouseEvent) => {
						event.stopPropagation();
						void tabManager.state.captures.capture(tab).catch((error) => {
							toast.error('Failed to capture tab', { description: extractErrorMessage(error) });
						});
					}}
				>
					<ArchiveIcon />
				</Button>
				<Button variant="ghost" size="icon-xs" class="text-destructive" tooltip="Close" onclick={(event: MouseEvent) => { event.stopPropagation(); void browserState.close(tab.id); }}><XIcon /></Button>
	</Item.Actions>
</Item.Root>
