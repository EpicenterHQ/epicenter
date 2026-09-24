<script lang="ts">
	import { AccountPopover } from '@epicenter/app-shell/account-popover';
	import { LightSwitch } from '@epicenter/ui/light-switch';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import MessageSquareIcon from '@lucide/svelte/icons/message-square';
	import MessageSquarePlusIcon from '@lucide/svelte/icons/message-square-plus';
	import { auth } from '$lib/auth.svelte.js';
	import type { ChatSummary } from '$lib/chat/messages.js';
	import type { createEntriesState } from '$lib/entries.svelte.js';
	import EntriesPanel from './EntriesPanel.svelte';

	let {
		entries,
		chats,
		selectedChatId,
		onNew,
		onSwitch,
	}: {
		entries: ReturnType<typeof createEntriesState>;
		chats: ChatSummary[];
		selectedChatId: string;
		onNew: () => void;
		onSwitch: (id: string) => void;
	} = $props();
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
		{#if chats.length > 0}
			<Sidebar.Group class="group-data-[collapsible=icon]:hidden">
				<Sidebar.GroupLabel>Chats</Sidebar.GroupLabel>
				<Sidebar.GroupContent>
					<Sidebar.Menu>
						{#each chats as chat (chat.id)}
							<Sidebar.MenuItem>
								<Sidebar.MenuButton
									isActive={selectedChatId === chat.id}
									tooltipContent={chat.title}
									onclick={() => onSwitch(chat.id)}
								>
									<MessageSquareIcon class="size-4" />
									<span class="truncate">{chat.title}</span>
								</Sidebar.MenuButton>
							</Sidebar.MenuItem>
						{/each}
					</Sidebar.Menu>
				</Sidebar.GroupContent>
			</Sidebar.Group>
		{/if}
		<EntriesPanel {entries} />
	</Sidebar.Content>

	<Sidebar.Rail />
</Sidebar.Root>
