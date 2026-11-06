<!--
	Messages: Replies, read from the Messages folder on this computer, and
	conversations, read from Beeper when it is connected. Served by the
	local program, it opens on your replies and connects with the saved
	token, if any; served any other way, or on request, it runs the
	fictional demo. Connecting never sends.
-->
<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { Loading } from '@epicenter/ui/loading';
	import { QueryClient, createInfiniteQuery, createMutation, createQuery, setQueryClientContext } from '@tanstack/svelte-query';
	import { onMount } from 'svelte';
	import { type Backend, createDemoBackend, local, NOT_SERVED_HERE } from './backend.js';
	import ConversationView from './Conversation.svelte';
	import Staging from './Staging.svelte';
	import { needsCheck, sendable } from './replies.js';

	let { servedLocally }: { servedLocally: boolean } = $props();
	const queryClient = new QueryClient();
	setQueryClientContext(queryClient);
	const demo = createDemoBackend();
	// svelte-ignore state_referenced_locally
	let backend = $state<Backend>(servedLocally ? local : demo);
	/** The connected Beeper accounts' profile; null while Beeper is not connected. */
	let profile = $state<string | null>(null);
	let selected = $state<string>();
	/** On a narrow screen, whether the main pane (Replies or a conversation) shows instead of the list. */
	let opened = $state(false);
	let filter = $state('');
	let showConnect = $state(false);
	let token = $state('');
	// svelte-ignore state_referenced_locally
	let notice = $state(servedLocally ? '' : NOT_SERVED_HERE);

	const staging = createQuery(() => ({
		queryKey: ['staging', backend.kind],
		queryFn: async () => {
			const answer = await backend.request({ action: 'replies' });
			if (answer.kind !== 'replies') throw new Error(answer.kind === 'error' ? answer.message : 'Could not read your replies.');
			return answer;
		},
		refetchInterval: 3000,
		staleTime: 0,
	}));
	const replies = $derived(staging.data?.replies ?? []);
	// Following Beeper's delivery reports reads Beeper and settles the
	// journal; it never sends.
	const awaitingDelivery = $derived(profile !== null && [...replies.map((reply) => reply.send), ...(staging.data?.unfiled ?? [])].some((send) => send?.state === 'accepted'));
	createQuery(() => ({
		queryKey: ['delivery', backend.kind, profile],
		queryFn: async () => {
			const answer = await backend.request({ action: 'check' });
			await queryClient.invalidateQueries({ queryKey: ['staging'] });
			return answer.kind;
		},
		enabled: awaitingDelivery,
		refetchInterval: 4000,
		staleTime: 0,
	}));
	const readyCount = $derived(replies.filter((reply) => sendable(reply, profile)).length);
	const toCheck = $derived([...replies.map((reply) => reply.send), ...(staging.data?.unfiled ?? [])].filter(needsCheck).length);

	const chats = createInfiniteQuery(() => ({
		queryKey: ['beeper', backend.kind, profile, 'chats'],
		// SAFETY: the first page has no cursor; later pages use string cursors.
		initialPageParam: undefined as string | undefined,
		queryFn: async ({ pageParam }) => {
			const answer = await backend.request({ action: 'chats', cursor: pageParam });
			if (answer.kind !== 'chats') throw new Error(answer.kind === 'error' ? answer.message : 'Could not read conversations.');
			return answer.page;
		},
		getNextPageParam: (page) => page.cursor ?? undefined,
		enabled: profile !== null,
		refetchInterval: 5000,
		staleTime: 0,
	}));
	const all = $derived([...new Map((chats.data?.pages.flatMap((page) => page.items) ?? []).map((chat) => [chat.id, chat])).values()].sort((a, b) => b.activity.localeCompare(a.activity)));
	const visible = $derived(all.filter((chat) => `${chat.title} ${chat.network}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase())));
	const current = $derived(all.find((chat) => chat.id === selected));
	const previews = $derived.by(() => {
		const found = new Map<string, string>();
		for (const reply of replies) {
			if (reply.profile !== profile || found.has(reply.chatId)) continue;
			found.set(reply.chatId, `${reply.status === 'ready' ? 'Ready' : 'Draft'}: ${reply.body.trim().replace(/\s+/g, ' ')}`);
		}
		return found;
	});

	async function use(next: Backend, connected: string | null) {
		await queryClient.cancelQueries({ queryKey: ['beeper'] });
		queryClient.removeQueries({ queryKey: ['beeper'] });
		selected = undefined;
		opened = false;
		backend = next;
		profile = connected;
	}
	/** Connect with `token`, or the saved one. Reads only; nothing is sent. */
	async function connectWith(next: Backend, given?: string) {
		const answer = await next.request({ action: 'connect', ...(given ? { token: given } : {}) });
		if (answer.kind !== 'connected') return answer.kind === 'error' ? answer.message : 'Could not connect.';
		await use(next, answer.profile);
		return null;
	}
	const connect = createMutation(() => ({
		mutationFn: async () => {
			const given = token.trim();
			token = '';
			const refused = await connectWith(local, given || undefined);
			notice = refused ?? '';
			if (refused === null) showConnect = false;
		},
		onError: () => { token = ''; notice = 'Could not connect to Beeper.'; },
	}));
	const disconnect = createMutation(() => ({
		mutationFn: async () => {
			const answer = await local.request({ action: 'disconnect' });
			if (answer.kind !== 'disconnected') { notice = answer.kind === 'error' ? answer.message : 'Could not disconnect.'; return; }
			await use(local, null);
			notice = '';
		},
		onError: () => { notice = 'Could not remove the saved Beeper connection.'; },
	}));
	onMount(() => {
		if (servedLocally) void connectWith(local);
		else void connectWith(demo);
	});
</script>

<main class="flex h-dvh min-h-0 flex-col overflow-hidden">
	<header class="flex flex-wrap items-center gap-3 border-b px-4 py-3">
		<h1 class="font-semibold">Messages</h1>
		{#if backend.kind === 'demo'}<Badge variant="secondary">Demo · fictional conversations</Badge>
		{:else}<Badge variant={profile === null ? 'outline' : 'default'}>{profile === null ? 'Beeper not connected' : 'Live Beeper'}</Badge>{/if}
		<div class="ml-auto flex flex-wrap gap-2">
			<Button variant="ghost" size="sm" disabled={staging.isFetching || chats.isFetching} onclick={() => void queryClient.invalidateQueries()}>Refresh</Button>
			{#if backend.kind === 'local'}
				{#if profile === null}<Button variant="outline" size="sm" onclick={() => { showConnect = !showConnect; token = ''; }}>Connect Beeper</Button>
				{:else}<Button variant="outline" size="sm" disabled={disconnect.isPending} onclick={() => disconnect.mutate()}>Disconnect</Button>{/if}
				<Button variant="ghost" size="sm" onclick={() => { notice = ''; showConnect = false; void connectWith(demo); }}>Try the demo</Button>
			{:else if servedLocally}
				<Button variant="outline" size="sm" onclick={async () => { notice = ''; await use(local, null); const refused = await connectWith(local); if (refused) notice = refused; }}>Leave the demo</Button>
			{/if}
		</div>
	</header>
	{#if showConnect}
		<form class="space-y-2 border-b bg-muted/30 p-4" onsubmit={(event) => { event.preventDefault(); connect.mutate(); }}>
			<p class="text-sm">Connect to your real conversations on this computer. Create a token in Beeper Settings → Integrations → Approved connections. It is stored in the device keychain. Connecting sends nothing.</p>
			<label for="beeper-token" class="text-sm">Beeper access token</label>
			<div class="flex gap-2"><Input id="beeper-token" type="password" autocomplete="off" placeholder="Paste a new token, or use your saved connection" bind:value={token} /><Button type="submit" disabled={connect.isPending}>{connect.isPending ? 'Connecting…' : 'Connect to live Beeper'}</Button></div>
		</form>
	{/if}
	{#if notice}<p role="alert" class="border-b p-3 text-sm text-destructive">{notice}</p>{/if}
	{#if backend.kind === 'demo'}
		<div class="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-xs text-muted-foreground">
			<span>No real accounts are connected. Replies and sends stay in this demo.</span>
			<Button variant="ghost" size="sm" onclick={() => { demo.incoming(); void queryClient.invalidateQueries({ queryKey: ['beeper'] }); }}>Simulate incoming</Button>
			<Button variant="ghost" size="sm" onclick={() => { demo.failNext(); notice = 'The next demo send will get no answer.'; }}>Simulate send failure</Button>
		</div>
	{/if}
	<div class="flex min-h-0 flex-1">
		<aside class="w-full min-w-0 flex-col border-r md:flex md:w-80 md:shrink-0" class:hidden={opened} class:flex={!opened} aria-label="Conversations">
			<button class="block w-full border-b px-4 py-3 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring" class:bg-accent={selected === undefined} aria-current={selected === undefined ? 'true' : undefined} onclick={() => { selected = undefined; opened = true; }}>
				<span class="text-sm font-medium">Replies</span>
				<span class="block text-xs text-muted-foreground">{replies.length} {backend.kind === 'demo' ? 'in this demo' : 'in the folder'}{readyCount ? ` · ${readyCount} ready` : ''}{toCheck ? ` · ${toCheck} to check` : ''}</span>
			</button>
			{#if profile === null}
				<p class="p-4 text-sm text-muted-foreground">{backend.kind === 'local' ? 'Connect Beeper to read conversations. Your replies are here either way.' : 'Connecting the demo…'}</p>
			{:else}
				<div class="p-3"><Input aria-label="Filter conversations" placeholder="Find a conversation…" bind:value={filter} /></div>
				<div class="min-h-0 flex-1 overflow-y-auto">
					{#if chats.isPending}<Loading label="Loading conversations…" />{/if}
					{#if chats.error}<p role="alert" class="p-3 text-sm text-destructive">{chats.error.message}</p>{/if}
					{#each visible as chat (chat.id)}
						{@const preview = previews.get(chat.id)}
						<button class="block w-full border-b px-4 py-3 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring" class:bg-accent={selected === chat.id} aria-current={selected === chat.id ? 'true' : undefined} onclick={() => { selected = chat.id; opened = true; }}>
							<div class="flex items-baseline justify-between gap-2"><span class="truncate text-sm font-medium">{chat.title}</span><span class="shrink-0 text-xs text-muted-foreground">{chat.network}</span></div>
							<p class="truncate text-xs text-muted-foreground">{#if preview}<span class="font-medium text-primary">{preview}</span>{:else}{chat.preview || 'No message preview'}{/if}</p>
						</button>
					{/each}
					{#if !chats.isPending && !chats.error && visible.length === 0}<p class="p-4 text-sm text-muted-foreground">{filter ? 'No matching conversations in the loaded chats.' : 'No conversations available.'}</p>{/if}
					{#if chats.hasNextPage}<Button class="m-3" variant="outline" size="sm" disabled={chats.isFetchingNextPage} onclick={() => void chats.fetchNextPage()}>Load more conversations</Button>{/if}
				</div>
			{/if}
		</aside>
		<div class="min-h-0 min-w-0 flex-1 md:block" class:hidden={!opened}>
			{#if current && profile !== null}
				{#key `${backend.kind}:${profile}:${current.id}`}<ConversationView {backend} chat={current} {profile} replies={replies.filter((reply) => reply.chatId === current.id)} onBack={() => { selected = undefined; opened = false; }} />{/key}
			{:else if staging.error}
				<p role="alert" class="p-4 text-sm text-destructive">{staging.error.message}</p>
			{:else if staging.isPending}
				<Loading label="Loading your replies…" />
			{:else}
				<Staging {backend} {profile} {replies} invalid={staging.data?.invalid ?? []} unfiled={staging.data?.unfiled ?? []} connectHint={backend.kind === 'local' ? 'Connect Beeper to send' : ''} onBack={() => { opened = false; }} />
			{/if}
		</div>
	</div>
</main>
