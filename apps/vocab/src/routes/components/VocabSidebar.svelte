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
	import { getVocabApp } from '$lib/context';
	import EntriesPanel from './EntriesPanel.svelte';

	const vocab = getVocabApp();

	/** Which conversation is open for renaming, if any. The list is the only way
	 * back to a topic (ADR-0195), and a seed or a practice selection titles a
	 * conversation the learner never named, so correcting a title has to be
	 * reachable from the list itself. */
	let renamingId = $state<ConversationId | null>(null);

	/** Take the edit unless it is empty: a blank title would leave a nameless row
	 * that the first-message auto-title no longer reclaims. */
	function commitRename(conversation: ConversationHandle, draft: string) {
		const title = draft.trim();
		if (title && title !== conversation.title) conversation.title = title;
		renamingId = null;
	}

	let {
		conversations,
		activeConversationId,
		onCreate,
		onSwitch,
		onPractice,
	}: {
		conversations: ConversationHandle[];
		activeConversationId: ConversationId | null;
		onCreate: () => void;
		onSwitch: (conversationId: ConversationId) => void;
		onPractice: (entryTexts: string[]) => void;
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
				dataSync={vocab}
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
							{#if renamingId === conv.id}
								<input
									{@attach (node) => node.select()}
									class="w-full rounded-sm border bg-background px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
									aria-label="Rename conversation"
									value={conv.title}
									onblur={(event) => commitRename(conv, event.currentTarget.value)}
									onkeydown={(event) => {
										// Escape restores the title before blurring, so the commit
										// on the way out is a no-op whether or not the browser
										// fires blur for an element being removed.
										if (event.key === 'Escape') event.currentTarget.value = conv.title;
										if (event.key === 'Enter' || event.key === 'Escape')
											event.currentTarget.blur();
									}}
								/>
							{:else}
								<Sidebar.MenuButton
									isActive={conv.id === activeConversationId}
									onclick={() => onSwitch(conv.id)}
									ondblclick={() => (renamingId = conv.id)}
									tooltipContent="{conv.title} (double-click to rename)"
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
							{/if}
						</Sidebar.MenuItem>
					{/each}
				</Sidebar.Menu>
			</Sidebar.GroupContent>
		</Sidebar.Group>

		<EntriesPanel {onPractice} />
	</Sidebar.Content>

	<Sidebar.Rail />
</Sidebar.Root>
