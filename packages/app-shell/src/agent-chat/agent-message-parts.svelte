<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Markdown } from '@epicenter/ui/markdown';
	import { cn } from '@epicenter/ui/utils';
	import AlertCircleIcon from '@lucide/svelte/icons/circle-alert';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import WrenchIcon from '@lucide/svelte/icons/wrench';
	import type {
		AgentMessage,
		AgentToolCallPart,
		AgentToolResultPart,
	} from '@epicenter/agent';
	import type { ConversationHandle } from './agent-chat.svelte.js';

	let {
		message,
		conversation,
		resolveToolTitle,
		onAlwaysAllow,
	}: {
		/** The message whose parts are rendered, in order. */
		message: AgentMessage;
		/** The conversation this message belongs to: the one owner of approval
		 * state, so each tool-call's buttons read and settle directly against it
		 * rather than being re-plumbed through the caller. */
		conversation: ConversationHandle;
		/** Map a tool name to a human title, or undefined to fall back to title-case.
		 * Injected by an app that names its tools. */
		resolveToolTitle?: (toolName: string) => string | undefined;
		/** Trust this tool from now on, then approve. Renders an "Always Allow"
		 * button only when provided; the trust set stays in the app. */
		onAlwaysAllow?: () => void;
	} = $props();

	/** Title-case a snake_case tool name: `list_tabs` becomes `List Tabs`. */
	function titleCase(toolName: string): string {
		return toolName
			.split('_')
			.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
			.join(' ');
	}

	/**
	 * Exhaustiveness guard for the part dispatch: `part` is `never` only while
	 * every member of `AgentMessagePart` has a branch above the `{:else}`, so a new
	 * part type becomes a type error here.
	 *
	 * The branch is still reachable at runtime: a finished message round-trips
	 * through the workspace CRDT as plain JSON, so a newer build can persist part
	 * types this build does not know about.
	 */
	function unknownPartType(part: never): string {
		return (part as { type: string }).type;
	}
</script>

{#snippet toolTranscript(text: string, muted = false)}
	<pre
		class={cn(
			'mt-1 whitespace-pre-wrap break-all rounded-md bg-muted/50 p-2 font-mono text-xs',
			muted && 'text-muted-foreground',
		)}
	>{text}</pre>
{/snippet}

{#snippet toolCall(part: AgentToolCallPart)}
	{@const awaitingApproval =
		part.toolCallId === conversation.pendingApprovalCallId}
	{@const displayName =
		resolveToolTitle?.(part.toolName) ?? titleCase(part.toolName)}
	{@const argumentsText = JSON.stringify(part.input, null, 2)}
	<div class="flex flex-col gap-1 py-1">
		<div class="flex items-center gap-1.5">
			{#if awaitingApproval}
				<ShieldAlertIcon class="size-3 text-amber-500" />
			{:else}
				<WrenchIcon class="size-3 text-muted-foreground" />
			{/if}
			<Badge variant={awaitingApproval ? 'secondary' : 'status.running'}>
				{displayName}
			</Badge>
		</div>

		{#if awaitingApproval}
			<div class="flex items-center gap-1.5 pl-[1.125rem]">
				<Button
					variant="outline"
					size="sm"
					onclick={() => conversation.approveToolCall()}
				>
					Allow
				</Button>
				{#if onAlwaysAllow}
					<Button variant="outline" size="sm" onclick={onAlwaysAllow}>
						Always Allow
					</Button>
				{/if}
				<Button
					variant="ghost"
					size="sm"
					class="text-muted-foreground"
					onclick={() => conversation.denyToolCall()}
				>
					Deny
				</Button>
			</div>
		{/if}

		{#if argumentsText !== '{}'}
			<details class="pl-[1.125rem]">
				<summary
					class="cursor-pointer text-xs text-muted-foreground hover:text-foreground"
				>
					Arguments
				</summary>
				{@render toolTranscript(argumentsText)}
			</details>
		{/if}
	</div>
{/snippet}

{#snippet toolResult(part: AgentToolResultPart)}
	{#if part.isError}
		<div
			class="flex items-start gap-1.5 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
		>
			<AlertCircleIcon class="mt-0.5 size-3 shrink-0" />
			<span class="whitespace-pre-wrap break-all">{part.content}</span>
		</div>
	{:else}
		<details class="pl-[1.125rem]">
			<summary
				class="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
			>
				<CheckIcon class="size-3 text-emerald-500" />
				Result
			</summary>
			{@render toolTranscript(part.content)}
			{#if part.details !== undefined}
				{@render toolTranscript(JSON.stringify(part.details, null, 2), true)}
			{/if}
		</details>
	{/if}
{/snippet}

{#each message.parts as part, i (`${part.type}-${i}`)}
	{#if part.type === 'text'}
		<Markdown content={part.text} />
	{:else if part.type === 'tool-call'}
		{@render toolCall(part)}
	{:else if part.type === 'tool-result'}
		{@render toolResult(part)}
	{:else}
		<div class="py-1 text-xs text-muted-foreground italic">
			[Unsupported part: {unknownPartType(part)}]
		</div>
	{/if}
{/each}
