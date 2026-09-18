<script lang="ts">
	import type { AgentMessage } from '@epicenter/agent';
	import type { Snippet } from 'svelte';
	import {
		CrossDeviceModelGap,
		type InferenceConnections,
		InferencePicker,
	} from '../inference-picker/index.js';
	import type { ConversationHandle } from './agent-chat.svelte.js';
	import AgentMessageParts from './agent-message-parts.svelte';
	import ChatErrorBanner from './chat-error-banner.svelte';
	import ChatInput from './chat-input.svelte';
	import MessageList from './message-list.svelte';

	let {
		conversation,
		connections,
		onSignIn,
		onUpgrade,
		message,
		resolveToolTitle,
		onAlwaysAllow,
		emptyState,
		placeholder,
		inputAccessory,
	}: {
		/** The active conversation this thread renders end to end. */
		conversation: ConversationHandle;
		/** The device connection registry (ADR-0059), for the model picker and gap. */
		connections: InferenceConnections;
		/** Open the app's sign-in flow (the turn failed with HTTP 401). Omit to hide
		 * the Sign In button in the error banner. */
		onSignIn?: () => void;
		/** Open the app's upgrade/billing flow (the turn failed with HTTP 402). Omit
		 * to hide the Upgrade button in the error banner. */
		onUpgrade?: () => void;
		/** Override how one message's content renders (vocab's pinyin pass). Omit to
		 * use the built-in renderer (text + tool calls), wired to this conversation's
		 * approval state and the `resolveToolTitle` / `onAlwaysAllow` seams below. The
		 * second argument is true for the in-flight message. */
		message?: Snippet<[AgentMessage, boolean]>;
		/** Map a tool name to a human title for the built-in renderer; ignored when a
		 * `message` override is supplied. */
		resolveToolTitle?: (toolName: string) => string | undefined;
		/** "Always Allow" action for the built-in renderer; ignored when a `message`
		 * override is supplied. The button shows only when set; trust stays in the app. */
		onAlwaysAllow?: () => void;
		/** Optional empty-state override; defaults to a generic chat prompt. */
		emptyState?: Snippet;
		/** Optional input placeholder. */
		placeholder?: string;
		/** Optional control rendered in the input row (Vocab's dictation mic). */
		inputAccessory?: Snippet;
	} = $props();
</script>

{#snippet defaultMessage(msg: AgentMessage)}
	<AgentMessageParts
		message={msg}
		{conversation}
		{resolveToolTitle}
		{onAlwaysAllow}
	/>
{/snippet}

<div class="flex min-h-0 flex-1 flex-col">
	<div class="min-h-0 flex-1">
		<MessageList
			messages={conversation.messages}
			streaming={conversation.streaming}
			status={conversation.status}
			onReload={() => conversation.reload()}
			message={message ?? defaultMessage}
			{emptyState}
		/>
	</div>

	<ChatErrorBanner {conversation} {onSignIn} {onUpgrade} />

	<CrossDeviceModelGap
		scope={conversation.id}
		model={conversation.model}
		{connections}
		onUseDefault={() => conversation.useDefaultModel()}
	/>

	<!-- The shared model-first picker (ADR-0059): the conversation's model bound to
	     this device's connection registry. Locked mid-turn so a transcript never
	     spans backends. -->
	<div class="flex items-center gap-2 bg-background px-2 pt-1.5">
		<InferencePicker
			scope={conversation.id}
			model={conversation.model}
			onSelectModel={(model) => (conversation.model = model)}
			{connections}
			disabled={conversation.isLoading}
		/>
	</div>

	<ChatInput
		bind:value={conversation.inputValue}
		canSend={conversation.canSend}
		isGenerating={conversation.isLoading}
		onSend={(content) => conversation.sendMessage(content)}
		onStop={() => conversation.stop()}
		{placeholder}
		accessory={inputAccessory}
	/>
</div>
