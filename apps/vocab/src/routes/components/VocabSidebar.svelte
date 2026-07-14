<script lang="ts">
	import { AccountPopover } from '@epicenter/app-shell/account-popover';
	import type { ConversationHandle } from '@epicenter/app-shell/agent-chat';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import type { ConversationId } from '@epicenter/chat';
	import MessageSquarePlusIcon from '@lucide/svelte/icons/message-square-plus';
	import MessageSquareTextIcon from '@lucide/svelte/icons/message-square-text';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import { instanceSetting } from '$lib/instance';
	import { auth } from '$lib/platform/auth';
	import { dictation } from '$lib/state/dictation.svelte';
	import EntriesPanel from './EntriesPanel.svelte';

	let {
		conversations,
		activeConversationId,
		onCreate,
		onSwitch,
		onPractice,
		generating,
	}: {
		conversations: ConversationHandle[];
		activeConversationId: ConversationId | null;
		onCreate: () => void;
		onSwitch: (conversationId: ConversationId) => void;
		onPractice: (entryTexts: string[]) => void;
		generating: boolean;
	} = $props();
</script>

<Sidebar.Root collapsible="icon">
	<Sidebar.Header>
		<div
			class="flex items-center justify-between px-2 py-1 group-data-[collapsible=icon]:hidden"
		>
			<span class="text-sm font-semibold">Vocab</span>
			<AccountPopover
				{auth}
				syncNoun="conversations"
				disabledReason={dictation.status !== 'idle'
					? 'Finish dictating to change your account'
					: undefined}
				instanceConnect={{ appName: 'Vocab', setting: instanceSetting }}
			/>
		</div>
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<Sidebar.MenuButton
					size="lg"
					onclick={() => onCreate()}
					tooltipContent="New conversation"
					aria-label="New conversation"
				>
					<MessageSquarePlusIcon class="size-4" />
					<span>New Conversation</span>
				</Sidebar.MenuButton>
			</Sidebar.MenuItem>
		</Sidebar.Menu>
	</Sidebar.Header>

	<Sidebar.Content>
		<Sidebar.Group>
			<Sidebar.GroupLabel>Conversations</Sidebar.GroupLabel>
			<Sidebar.GroupContent>
				<Sidebar.Menu>
					{#each conversations as conv (conv.id)}
						<Sidebar.MenuItem>
							<Sidebar.MenuButton
								isActive={conv.id === activeConversationId}
								onclick={() => onSwitch(conv.id)}
								tooltipContent={conv.title}
							>
								<MessageSquareTextIcon class="size-4" />
								<span>{conv.title}</span>
							</Sidebar.MenuButton>
							<Sidebar.MenuAction
								showOnHover
								aria-label="Delete conversation"
								onclick={() => conv.delete()}
							>
								<TrashIcon class="size-3.5" />
							</Sidebar.MenuAction>
						</Sidebar.MenuItem>
					{/each}
				</Sidebar.Menu>
			</Sidebar.GroupContent>
		</Sidebar.Group>

		<EntriesPanel {onPractice} {generating} />
	</Sidebar.Content>

	<Sidebar.Rail />
</Sidebar.Root>
