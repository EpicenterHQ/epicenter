<script lang="ts">
	import { AccountPopover } from '@epicenter/app-shell/account-popover';
	import { LightSwitch } from '@epicenter/ui/light-switch';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import MessageSquarePlusIcon from '@lucide/svelte/icons/message-square-plus';
	import { auth } from '$lib/auth.svelte.js';
	import EntriesPanel from './EntriesPanel.svelte';

	let { onNew }: { onNew: () => void } = $props();
</script>

<Sidebar.Root collapsible="icon">
	<Sidebar.Header>
		<div class="flex items-center justify-between px-2 py-1 group-data-[collapsible=icon]:hidden">
			<span class="text-sm font-semibold">Vocab</span>
			<div class="flex items-center gap-1">
				<LightSwitch variant="ghost" />
				<AccountPopover {auth} syncNoun="entries" />
			</div>
		</div>
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<Sidebar.MenuButton
					size="lg"
					onclick={onNew}
					tooltipContent="New chat"
					aria-label="New chat"
				>
					<MessageSquarePlusIcon class="size-4" />
					<span>New chat</span>
				</Sidebar.MenuButton>
			</Sidebar.MenuItem>
		</Sidebar.Menu>
	</Sidebar.Header>

	<Sidebar.Content>
		<EntriesPanel />
	</Sidebar.Content>

	<Sidebar.Rail />
</Sidebar.Root>
