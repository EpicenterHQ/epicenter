<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Badge, type BadgeVariant } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Command from '@epicenter/ui/command';
	import * as Item from '@epicenter/ui/item';
	import * as Popover from '@epicenter/ui/popover';
	import { Spinner } from '@epicenter/ui/spinner';
	import type { HomeInvocation } from '../host.ts';
	import Composer from './Composer.svelte';
	import type { createSession } from './session.svelte.ts';
	import Transcript from './Transcript.svelte';

	/**
	 * The assistant session: transcript, direct runs, approvals, and composer,
	 * with the controls that belong to a conversation rather than to the shell
	 * (ADR-0189).
	 *
	 * The session itself is owned above this pane, so switching to Apps or
	 * Settings and back keeps the live socket, the transcript, and an unsent
	 * draft exactly where they were.
	 */

	const { session }: { session: ReturnType<typeof createSession> } = $props();

	let toolsOpen = $state(false);

	const invocationBadge = {
		running: { label: 'Running', variant: 'status.running' },
		succeeded: { label: 'Done', variant: 'status.completed' },
		failed: { label: 'Failed', variant: 'status.failed' },
	} as const satisfies Record<
		HomeInvocation['status'],
		{ label: string; variant: BadgeVariant }
	>;

	function formatApprovalInput(input: unknown): string {
		return JSON.stringify(input, null, 2);
	}

	/**
	 * A tool is runnable from the command surface only when submitting `{}` is
	 * the whole visible payload (the consent boundary of the direct-forms spec):
	 * no input schema at all, or an object schema with no required properties.
	 * Everything else waits for the direct command forms.
	 */
	function canRunWithoutInput(tool: { inputSchema?: unknown }): boolean {
		const schema = tool.inputSchema;
		if (schema === undefined) return true;
		if (typeof schema !== 'object' || schema === null || Array.isArray(schema))
			return false;
		const { type, required } = schema as { type?: unknown; required?: unknown };
		if (type !== 'object') return false;
		return (
			required === undefined ||
			(Array.isArray(required) && required.length === 0)
		);
	}
</script>

<div class="flex h-full flex-col">
	<div class="flex flex-none items-center justify-end gap-2 px-3 pt-2">
		<Popover.Root bind:open={toolsOpen}>
			<Popover.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="outline" size="sm">
						{session.tools.length}
						{session.tools.length === 1 ? 'tool' : 'tools'}
					</Button>
				{/snippet}
			</Popover.Trigger>
			<Popover.Content class="w-96 p-0" align="end">
				<Command.Root loop>
					<Command.Input placeholder="Search tools..." />
					<Command.List class="max-h-[50vh]">
						<Command.Empty>No tools match.</Command.Empty>
						{#each session.tools as tool (tool.name)}
							<Command.Item
								value="{tool.name} {tool.title ?? ''} {tool.description ?? ''}"
								disabled={!canRunWithoutInput(tool)}
								onSelect={() => {
									session.invoke(tool.name);
									toolsOpen = false;
								}}
							>
								<div class="min-w-0 flex-1">
									<div class="flex items-baseline gap-2">
										<code class="font-mono text-xs">{tool.name}</code>
										{#if tool.title}
											<span class="truncate text-muted-foreground">
												{tool.title}
											</span>
										{/if}
									</div>
									{#if tool.description}
										<p class="truncate text-xs text-muted-foreground">
											{tool.description}
										</p>
									{/if}
								</div>
								<span class="text-xs text-muted-foreground">
									{canRunWithoutInput(tool) ? 'Run' : 'Needs input'}
								</span>
							</Command.Item>
						{/each}
					</Command.List>
				</Command.Root>
			</Popover.Content>
		</Popover.Root>
		<Button variant="ghost" size="sm" onclick={() => session.clear()}>
			New chat
		</Button>
	</div>

	<Transcript snapshot={session.snapshot} />

	{#if session.snapshot.error}
		<Alert.Root variant="destructive" class="mx-3 mb-2 w-auto flex-none">
			<Alert.Title>
				Turn failed{session.snapshot.error.code
					? ` (${session.snapshot.error.code})`
					: ''}
			</Alert.Title>
			<Alert.Description>{session.snapshot.error.message}</Alert.Description>
		</Alert.Root>
	{/if}

	{#if session.invocations.length > 0}
		<section
			class="max-h-[30vh] flex-none overflow-y-auto px-3 pb-2"
			aria-label="Direct runs"
		>
			<Item.Group>
				{#each [...session.invocations].reverse() as invocation (invocation.id)}
					<Item.Root variant="outline" size="sm">
						<Item.Content>
							<Item.Title>
								<code class="font-mono text-xs">{invocation.toolName}</code>
								<Badge variant={invocationBadge[invocation.status].variant}>
									{invocationBadge[invocation.status].label}
								</Badge>
							</Item.Title>
							{#if invocation.content !== undefined}
								<pre
									class="max-h-24 overflow-auto font-mono text-xs whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">{invocation.content}</pre>
							{/if}
						</Item.Content>
						{#if invocation.status === 'running'}
							<Item.Actions>
								<Spinner class="size-3.5" />
							</Item.Actions>
						{/if}
					</Item.Root>
				{/each}
			</Item.Group>
		</section>
	{/if}

	{#if session.pendingApprovals.length > 0}
		<!-- Always stacked: copy above actions, at every width. Approvals are
		     rare and sit above the composer, so vertical space is the honest
		     dimension; one layout serves the desktop window and a remote phone
		     alike. -->
		<section class="grid flex-none gap-2 px-3 pb-2" aria-label="Pending approvals">
			{#each session.pendingApprovals as approval (approval.id)}
				<Alert.Root variant="warning">
					<Alert.Title>{approval.title ?? approval.toolName}</Alert.Title>
					<Alert.Description>
						{#if approval.description}
							<p>{approval.description}</p>
						{/if}
						<pre
							class="max-h-32 w-full overflow-auto font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{formatApprovalInput(
								approval.input,
							)}</pre>
						<div class="flex flex-wrap gap-2 pt-1">
							<Button size="sm" onclick={() => session.approve(approval.id, true)}>
								Approve
							</Button>
							<Button
								size="sm"
								variant="outline"
								onclick={() => session.approve(approval.id, true, true)}
							>
								Always allow
							</Button>
							<Button
								size="sm"
								variant="ghost"
								onclick={() => session.approve(approval.id, false)}
							>
								Deny
							</Button>
						</div>
					</Alert.Description>
				</Alert.Root>
			{/each}
		</section>
	{/if}

	<Composer
		isGenerating={session.snapshot.isGenerating}
		isConnected={session.connection === 'open'}
		canRetry={session.snapshot.error !== null && !session.snapshot.isGenerating}
		onSend={(content) => session.send(content)}
		onStop={() => session.stop()}
		onRetry={() => session.retry()}
	/>
</div>
