<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import { onMount } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { pushState } from '$app/navigation';
	import { page } from '$app/state';
	import { createApi } from '$lib/api.js';
	import ApprovalQueue from '$lib/components/ApprovalQueue.svelte';
	import ApprovalCard from '$lib/components/ApprovalCard.svelte';
	import ThreadList from '$lib/components/ThreadList.svelte';
	import TokenGate from '$lib/components/TokenGate.svelte';
	import Transcript from '$lib/components/Transcript.svelte';
	import VoiceBar from '$lib/components/VoiceBar.svelte';
	import { VoiceQueue } from '$lib/queue.svelte.js';
	import { projectLabel } from '$lib/thread-filter.js';
	import { credentialsKey, loadCredentials, resolveCredentials, type Credentials, parseFragment } from '$lib/token-intake.js';

	let queue = $state.raw<VoiceQueue | null>(null);
	let mounted = $state(false);
	let gateError = $state('');
	let credentials = $state.raw<Credentials | null>(null);
	let pendingApiOrigin = $state<string | null>(null);
	const desktop = new MediaQuery('(min-width: 768px)');
	const threadView = $derived(page.state.view === 'thread');
	let heading = $state<HTMLHeadingElement | null>(null);
	let search = $state<HTMLInputElement | null>(null);
	let searchRequested = $state(false);
	const position = $derived(queue?.visibleOrder.indexOf(queue.selectedId ?? '') ?? -1);

	$effect(() => {
		if (!desktop.current && threadView && heading) heading.focus({ preventScroll: true });
	});
	$effect(() => {
		if (searchRequested && (desktop.current || !threadView) && search) {
			search.focus();
			searchRequested = false;
		}
	});

	function selectThread(id: string) {
		queue?.select(id);
		if (!desktop.current && !threadView) pushState('', { view: 'thread' });
	}

	function lock() {
		queue?.dispose();
		queue = null;
		localStorage.removeItem(credentialsKey);
	}

	function unlock(token: string) {
		queue?.dispose();
		gateError = '';
		credentials = { apiOrigin: pendingApiOrigin ?? credentials?.apiOrigin ?? '', token };
		pendingApiOrigin = null;
		localStorage.setItem(credentialsKey, JSON.stringify(credentials));
		const current = new VoiceQueue({
			api: createApi({
				baseUrl: credentials.apiOrigin,
				token,
				onUnauthorized: () => {
					if (queue === current) {
						lock();
						gateError = 'The gateway rejected this token. Paste the current access token.';
					}
				},
			}),
		});
		queue = current;
		void current.start();
	}

	function intakeFragment(fragment: string) {
		try {
			const resolved = resolveCredentials(parseFragment(fragment), loadCredentials(localStorage));
			queue?.dispose();
			queue = null;
			credentials = resolved.credentials;
			pendingApiOrigin = resolved.pendingApiOrigin;
			if (credentials) unlock(credentials.token);
			gateError = resolved.error ?? '';
		} catch (error) {
			gateError = error instanceof Error ? error.message : String(error);
		}
	}

	function hashchange() {
		const fragment = location.hash.slice(1);
		const params = new URLSearchParams(fragment);
		if (!params.has('token') && !params.has('api')) return;
		history.replaceState(history.state, '', location.pathname + location.search);
		intakeFragment(fragment);
	}

	onMount(() => {
		const fragment = window.__codexVoiceQueueFragment ?? '';
		delete window.__codexVoiceQueueFragment;
		intakeFragment(fragment);
		mounted = true;
		return () => queue?.dispose();
	});

	function keydown(event: KeyboardEvent) {
		if (!queue || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
		if (event.key === 'Escape' && queue.flow === 'recording') {
			event.preventDefault();
			queue.discard();
			return;
		}
		const target = event.target;
		if (
			target instanceof HTMLElement &&
			target.closest('input, textarea, select, [contenteditable="true"], [role="combobox"], [role="listbox"]')
		) return;

		if (event.key === '/') {
			event.preventDefault();
			searchRequested = true;
			if (!desktop.current && threadView) history.back();
			return;
		}
		switch (event.key) {
			case ' ':
				if (!queue.voiceOff && (desktop.current || threadView) && !(target instanceof HTMLElement && target.closest('button'))) {
					event.preventDefault();
					void queue.toggleRecord();
				}
				break;
			case 'j':
			case 'ArrowDown':
				event.preventDefault();
				queue.next();
				break;
			case 'k':
			case 'ArrowUp':
				event.preventDefault();
				queue.previous();
				break;
		}
	}
</script>

<svelte:window onkeydown={keydown} onhashchange={hashchange} />

{#if !mounted}
	<Loading class="h-dvh" label="Opening voice queue" />
{:else if !queue}
	<TokenGate onUnlock={unlock} error={gateError} apiOrigin={pendingApiOrigin ?? credentials?.apiOrigin ?? ''} />
{:else}
	{#if gateError}<Alert.Root variant="destructive"><Alert.Description>{gateError}</Alert.Description></Alert.Root>{/if}
	<Sidebar.Provider class="h-dvh min-h-0 overflow-hidden" style="--sidebar-width: 22rem">
		<ThreadList
			{queue}
			onLock={lock}
			onSelect={selectThread}
			active={!desktop.current && !threadView}
			{threadView}
			bind:search
		/>
		<main class="min-h-0 min-w-0 flex-1 flex-col overflow-hidden {threadView ? 'flex' : 'hidden'} md:flex">
			<header class="flex shrink-0 items-start gap-3 border-b p-4">
				<Button
					class="md:hidden"
					variant="ghost"
					size="sm"
					aria-label="Back to conversation list"
					onclick={() => history.back()}
				>
					<ChevronLeft /> Queue
				</Button>
				<div class="min-w-0 flex-1">
					<h2 bind:this={heading} tabindex="-1" class="line-clamp-2 text-sm font-semibold md:text-base">
						{queue.selected?.title ?? 'Codex Voice Queue'}
					</h2>
					{#if queue.selected}
						<p class="truncate text-xs text-muted-foreground" title={queue.selected.cwd}>
							{desktop.current ? queue.selected.cwd : projectLabel(queue.selected.cwd)}{queue.selected.gitBranch ? ` · ${queue.selected.gitBranch}` : ''}{queue.selected.source !== 'cli' ? ` · ${queue.selected.source}` : ''}
						</p>
						<p class="text-xs text-muted-foreground">
							{position >= 0 ? `${position + 1} of ${queue.visibleOrder.length}` : 'Outside filtered queue'}
						</p>
					{/if}
				</div>
			</header>
			<div class="max-h-40 shrink-0 overflow-auto md:max-h-64">
				{#if queue.error}
					<Alert.Root variant="destructive">
						<Alert.Title>Gateway request failed</Alert.Title>
						<Alert.Description>{queue.error}</Alert.Description>
					</Alert.Root>
				{/if}
				{#if queue.state?.appServer.state === 'down'}
					<Alert.Root variant="destructive">
						<Alert.Title>Codex app-server is down</Alert.Title>
						<Alert.Description>
							{queue.state.appServer.lastError}
							<details>
								<summary>Server diagnostics</summary>
								<pre class="max-h-40 overflow-auto whitespace-pre-wrap break-all text-xs">{queue.health?.appServer.stderr.join('\n') ?? 'No diagnostics available'}</pre>
							</details>
							<Button variant="outline" onclick={() => queue?.reload()}>Reconnect</Button>
						</Alert.Description>
					</Alert.Root>
				{/if}
				<div class="space-y-2 px-4">
					<div class="md:hidden"><ApprovalQueue {queue} onSelect={selectThread} excludeThreadId={queue.selectedId} /></div>
					{#each queue.state?.approvals.filter(approval => approval.threadId === queue?.selectedId) ?? [] as approval (approval.id)}
						<ApprovalCard
							{approval}
							onDecide={(id, decision) => queue!.decideApproval(id, decision)}
						/>
					{/each}
					{#each queue.state?.notices.filter(notice => notice.threadId === null || notice.threadId === queue?.selectedId).slice(-5) ?? [] as notice (notice.id)}
						<Alert.Root>
							<Alert.Description>{notice.message}</Alert.Description>
						</Alert.Root>
					{/each}
				</div>
			</div>
			{#if queue.selectedId}
				<Transcript {queue} active={desktop.current || threadView} />
			{:else if queue.loading}
				<Loading class="flex-1" label="Loading conversations" />
			{:else}
				<Empty.Root class="flex-1">
					<Empty.Header>
						<Empty.Title>Select a conversation</Empty.Title>
						<Empty.Description>Your local Codex conversations appear in the queue.</Empty.Description>
					</Empty.Header>
				</Empty.Root>
			{/if}
			<VoiceBar {queue} />
		</main>
	</Sidebar.Provider>
{/if}
