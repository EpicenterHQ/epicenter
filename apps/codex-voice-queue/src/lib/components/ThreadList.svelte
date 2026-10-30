<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import * as Select from '@epicenter/ui/select';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { Spinner } from '@epicenter/ui/spinner';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { tick } from 'svelte';
	import type { VoiceQueue } from '../queue.svelte.js';
	import ApprovalQueue from './ApprovalQueue.svelte';
	import { projectLabel } from '../thread-filter.js';

	let { queue, onLock, onSelect, active, threadView, search = $bindable(null) }: {
		queue: VoiceQueue;
		onLock: () => void;
		onSelect: (id: string) => void;
		active: boolean;
		threadView: boolean;
		search?: HTMLInputElement | null;
	} = $props();
	let root = $state<HTMLDivElement | null>(null);

	$effect(() => {
		if (!active) return;
		const id = queue.selectedId;
		void tick().then(() => {
			if (!active || queue.selectedId !== id) return;
			const row = root?.querySelector<HTMLButtonElement>('[aria-current="true"]');
			row?.scrollIntoView({ block: 'nearest' });
			if (document.activeElement !== search) row?.focus({ preventScroll: true });
		});
	});

	function relativeTime(seconds: number) {
		const minutes = Math.max(0, Math.floor((Date.now() - seconds * 1000) / 60000));
		if (minutes < 1) return 'now';
		if (minutes < 60) return `${minutes}m ago`;
		if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
		return `${Math.floor(minutes / 1440)}d ago`;
	}
</script>

<Sidebar.Root
	collapsible="none"
	bind:ref={root}
	class="min-h-0 w-full shrink-0 overflow-hidden md:w-(--sidebar-width) md:border-e {threadView ? 'hidden' : 'flex'} md:flex"
>
	<Sidebar.Header class="shrink-0">
		<ApprovalQueue {queue} {onSelect} />
		<div class="flex items-center justify-between gap-2">
			<h1 class="text-sm font-semibold">
				Voice queue <span class="text-muted-foreground">{queue.order.length}</span>
			</h1>
			<div class="flex items-center gap-1">
				<Button
					variant="ghost"
					size="icon-sm"
					tooltip="Reload conversations"
					disabled={queue.loading}
					onclick={() => queue.reload()}
				>
					{#if queue.loading}
						<Spinner />
					{:else}
						<RefreshCw />
					{/if}
				</Button>
				<Button variant="ghost" size="sm" onclick={onLock}>Lock</Button>
			</div>
		</div>
		<Input
			bind:ref={search}
			type="search"
			aria-label="Search conversations"
			placeholder="Search title, project, branch"
			bind:value={queue.query}
			onkeydown={(event) => {
				if (event.key !== 'Escape') return;
				event.preventDefault();
				event.stopPropagation();
				if (queue.flow === 'recording') queue.discard();
				if (queue.query) queue.query = '';
				else search?.blur();
			}}
		/>
		<Select.Root
			type="single"
			value={queue.project ?? ''}
			onValueChange={(value) => queue.project = value || null}
		>
			<Select.Trigger class="w-full min-w-0" aria-label="Filter by project">
				<span class="truncate">{queue.projects.find((project) => project.cwd === queue.project)?.label ?? 'All projects'}</span>
			</Select.Trigger>
			<Select.Content>
				<Select.Item value="" label="All projects" />
				{#each queue.projects as project (project.cwd)}
					<Select.Item value={project.cwd} label={`${project.label} (${project.count})`} />
				{/each}
			</Select.Content>
		</Select.Root>
		<p class="text-xs text-muted-foreground" aria-live="polite">{queue.visibleOrder.length} of {queue.order.length}</p>
		{#if queue.truncated}
			<p class="text-xs text-muted-foreground">Showing the first 5000 conversations.</p>
		{/if}
	</Sidebar.Header>
	<Sidebar.Content>
		<Sidebar.Menu>
			{#each queue.visibleOrder as id (id)}
				{@const thread = queue.threads.get(id)}
				{#if thread}
					{@const live = queue.state?.live[id] ?? thread.live}
					<Sidebar.MenuItem>
						<Sidebar.MenuButton
							size="lg"
							class="h-auto py-3"
							isActive={queue.selectedId === id}
							aria-current={queue.selectedId === id ? 'true' : undefined}
							onclick={() => onSelect(id)}
						>
							<div class="min-w-0 flex-1 space-y-1 text-left">
								<div class="truncate font-medium">{thread.title}</div>
								<div class="truncate text-xs text-muted-foreground">
									{relativeTime(thread.updatedAt)} · {projectLabel(thread.cwd)}{thread.source !== 'cli' ? ` · ${thread.source}` : ''}
								</div>
								<div class="flex flex-wrap gap-1">
									{#if queue.state?.approvals.some(approval => approval.threadId === id)}
										<Badge variant="outline">Needs approval</Badge>
									{/if}
									{#if live?.status === 'inProgress' || live?.threadStatus?.type === 'active' || (!live && thread.status.type === 'active')}
										<Badge variant="secondary">Working</Badge>
									{/if}
									{#if live?.status === 'failed'}
										<Badge variant="destructive">Failed</Badge>
									{/if}
									{#if queue.sent.has(id)}
										<Badge variant="outline">Sent</Badge>
									{/if}
								</div>
							</div>
						</Sidebar.MenuButton>
					</Sidebar.MenuItem>
				{/if}
			{/each}
		</Sidebar.Menu>
		{#if !queue.loading && queue.visibleOrder.length === 0 && queue.order.length > 0}
			<Empty.Root>
				<Empty.Header><Empty.Title>No conversations match</Empty.Title></Empty.Header>
				<Empty.Content><Button variant="outline" onclick={() => queue.clearFilters()}>Clear filters</Button></Empty.Content>
			</Empty.Root>
		{/if}
		{#if !queue.loading && queue.order.length === 0}
			<Empty.Root>
				<Empty.Header>
					<Empty.Title>No conversations</Empty.Title>
					<Empty.Description>Start a conversation in Codex, then reload.</Empty.Description>
				</Empty.Header>
			</Empty.Root>
		{/if}
	</Sidebar.Content>
</Sidebar.Root>
