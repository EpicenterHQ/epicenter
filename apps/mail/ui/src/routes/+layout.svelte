<script lang="ts">
	import { page } from '$app/state';
	import { onMount, untrack } from 'svelte';
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { Toaster } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { ModeWatcher } from 'mode-watcher';
	import SaveSearch from '$lib/components/SaveSearch.svelte';
	import { relativeTime } from '$lib/format.js';
	import { mailbox } from '$lib/mail.svelte.js';
	import '../app.css';

	let { children } = $props();
	let now = $state(Date.now());
	const status = $derived(mailbox.status());

	$effect(() => {
		const path = page.params.path ?? '';
		untrack(() => {
			void mailbox.open(path);
		});
	});

	onMount(() => {
		const stop = mailbox.watch();
		const timer = setInterval(() => {
			now = Date.now();
		}, 60_000);
		return () => {
			stop();
			clearInterval(timer);
		};
	});
</script>

<svelte:head>
	<title>Mail</title>
</svelte:head>

<Tooltip.Provider>
	<div class="min-h-dvh bg-background text-foreground">
		<header class="border-b px-4 py-4 sm:px-6">
			<div class="mx-auto flex max-w-6xl flex-wrap items-start justify-between gap-4">
				<div class="space-y-1">
					<h1 class="text-2xl font-semibold tracking-tight">
						<a href="#/">Mail</a>
					</h1>
					<p class="text-sm text-muted-foreground">
						Synthetic demo mailbox. No real account is connected.
					</p>
					<p class="text-xs text-muted-foreground" aria-live="polite">
						{status?.refreshedAt
							? `Updated ${relativeTime(status.refreshedAt, now)}`
							: 'Not loaded yet'}
						{#if status && status.pending > 0}
							<span>
								· {status.pending} label {status.pending === 1 ? 'change' : 'changes'} waiting to send
							</span>
						{/if}
					</p>
				</div>
				<div class="flex gap-2">
					<Button
						variant="outline"
						disabled={mailbox.busy()}
						onclick={() => mailbox.refresh()}
					>
						Refresh
					</Button>
					<Button
						disabled={mailbox.busy() || !status?.pending}
						onclick={() => mailbox.send()}
					>
						Send changes
					</Button>
				</div>
			</div>
		</header>
		<div class="mx-auto grid max-w-6xl md:grid-cols-[15rem_minmax(0,1fr)]">
			<aside class="space-y-6 border-b p-4 md:border-r md:border-b-0" aria-label="Mail navigation">
				<section class="space-y-2">
					<h2 class="text-sm font-semibold">Saved searches</h2>
					<nav aria-label="Saved searches" class="flex flex-wrap gap-1 md:flex-col">
						<a
							href="#/"
							aria-current={mailbox.path() === '' ? 'page' : undefined}
							class="rounded px-2 py-1.5 text-sm hover:bg-muted aria-[current=page]:bg-muted"
						>
							All mail
						</a>
						{#each mailbox.views() as view (view.path)}
							<a
								href="#/{view.path}"
								aria-current={mailbox.path() === view.path ? 'page' : undefined}
								class="break-words rounded px-2 py-1.5 text-sm
									hover:bg-muted aria-[current=page]:bg-muted"
							>
								{view.title ?? view.name}
							</a>
						{/each}
					</nav>
					<SaveSearch />
				</section>
				<section class="space-y-2">
					<h2 class="text-sm font-semibold">Labels</h2>
					<nav aria-label="Labels" class="flex flex-wrap gap-1 md:flex-col">
						{#each mailbox.labels() as label (label.id)}
							{@const query = label.id === 'INBOX' ? 'in:inbox' : `label:"${label.name}"`}
							<a
								href="#/search/{encodeURIComponent(query)}"
								aria-current={mailbox.query() === query ? 'page' : undefined}
								class="flex items-center justify-between gap-3 rounded px-2 py-1.5 text-sm
									hover:bg-muted aria-[current=page]:bg-muted"
							>
								<span>{label.name}</span>
								<span
									class="text-xs tabular-nums text-muted-foreground"
									aria-label="{label.total} total, {label.unread} unread"
								>
									{label.total} / {label.unread}
								</span>
							</a>
						{/each}
					</nav>
					<p class="text-xs text-muted-foreground">Total / unread</p>
				</section>
			</aside>
			<main class="min-w-0">
				{#if mailbox.problem()}
					<Alert.Root variant="destructive" class="m-4">
						<Alert.Title>Mail could not be loaded</Alert.Title>
						<Alert.Description>
							<p>{mailbox.problem()}</p>
							<Button variant="outline" size="sm" onclick={() => mailbox.reload()}>
								Try again
							</Button>
						</Alert.Description>
					</Alert.Root>
				{/if}
				{#if !mailbox.loaded()}
					<div role="status" aria-label="Loading mail" class="flex justify-center p-12">
						<Spinner />
					</div>
				{/if}
				{@render children()}
			</main>
		</div>
	</div>
	<Toaster position="bottom-center" />
	<ModeWatcher />
</Tooltip.Provider>
