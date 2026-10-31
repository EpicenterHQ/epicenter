<script lang="ts">
	import { getDevice } from './context.js';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { QueryClient, createInfiniteQuery, createMutation, setQueryClientContext } from '@tanstack/svelte-query';
	import { type Backend, createDemoBackend, requestBeeper } from './backend.js';
	import ConversationView from './Conversation.svelte';
	const { files } = getDevice();
	const queryClient = new QueryClient();
	setQueryClientContext(queryClient);
	const demo = createDemoBackend();
	let backend = $state<Backend>(demo);
	let selected = $state<string>();
	let filter = $state('');
	let showConnect = $state(false);
	let token = $state('');
	let notice = $state('');
	const chats = createInfiniteQuery(() => ({
		queryKey: ['beeper', backend.mode, backend.profile, 'chats'],
		// SAFETY: the first page has no cursor; later pages use string cursors.
		initialPageParam: undefined as string | undefined,
		queryFn: async ({ pageParam }) => {
			const answer = await backend.request({ action: 'chats', cursor: pageParam });
			if (answer.kind !== 'chats') throw new Error(answer.kind === 'error' ? answer.message : 'Could not read conversations.');
			return answer.page;
		},
		getNextPageParam: (page) => page.cursor ?? undefined,
		refetchInterval: 5000,
		staleTime: 0,
	}));
	const all = $derived([...new Map((chats.data?.pages.flatMap((page) => page.items) ?? []).map((chat) => [chat.id, chat])).values()].sort((a, b) => b.activity.localeCompare(a.activity)));
	const visible = $derived(all.filter((chat) => `${chat.title} ${chat.network}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase())));
	const current = $derived(all.find((chat) => chat.id === selected));
	const draftPreviews = $derived.by(() => {
		const previews = new Map<string, { label: string; text: string }>();
		for (const draft of files.drafts.items) {
			if (draft.mode !== backend.mode || draft.profile !== backend.profile) continue;
			const text = draft.body.trim().replace(/\s+/g, ' ');
			if (text) previews.set(draft.chatId, { label: 'Draft', text });
		}
		for (const attempt of files.attempts.items) {
			if (attempt.state !== 'sending' || attempt.mode !== backend.mode || attempt.profile !== backend.profile) continue;
			previews.set(attempt.chatId, { label: 'Check send', text: attempt.body.trim().replace(/\s+/g, ' ') });
		}
		return previews;
	});
	const connect = createMutation(() => ({
		mutationFn: async () => {
			const answer = await requestBeeper({ action: 'connect', ...(token.trim() ? { token: token.trim() } : {}) });
			token = '';
			if (answer.kind !== 'connected') { notice = answer.kind === 'error' ? answer.message : 'Could not connect.'; return; }
			await queryClient.cancelQueries({ queryKey: ['beeper'] });
			queryClient.removeQueries({ queryKey: ['beeper'] });
			selected = undefined;
			backend = { mode: 'live', profile: answer.profile, request: requestBeeper };
			showConnect = false; notice = '';
		},
		onError: () => { token = ''; notice = 'Could not connect to Beeper.'; },
	}));
	const disconnect = createMutation(() => ({
		mutationFn: async () => {
			const answer = await requestBeeper({ action: 'disconnect' });
			if (answer.kind !== 'disconnected') { notice = answer.kind === 'error' ? answer.message : 'Could not disconnect.'; return; }
			await queryClient.cancelQueries({ queryKey: ['beeper'] });
			queryClient.removeQueries({ queryKey: ['beeper'] });
			selected = undefined; backend = demo; notice = '';
		},
		onError: () => { notice = 'Could not remove the saved Beeper connection.'; },
	}));
</script>

<main class="flex h-dvh min-h-0 flex-col overflow-hidden">
	<header class="flex flex-wrap items-center gap-3 border-b px-4 py-3">
		<h1 class="font-semibold">Messages</h1>
		<Badge variant={backend.mode === 'demo' ? 'secondary' : 'default'}>{backend.mode === 'demo' ? 'Demo · fictional conversations' : 'Live Beeper'}</Badge>
		<div class="ml-auto flex gap-2">
			<Button variant="ghost" size="sm" disabled={chats.isFetching} onclick={() => void queryClient.invalidateQueries({ queryKey: ['beeper'] })}>Refresh</Button>
			{#if backend.mode === 'demo'}<Button variant="outline" size="sm" onclick={() => { showConnect = !showConnect; token = ''; }}>Connect Beeper</Button>
			{:else}<Button variant="outline" size="sm" disabled={disconnect.isPending} onclick={() => disconnect.mutate()}>Disconnect</Button>{/if}
		</div>
	</header>
	{#if showConnect}
		<form class="space-y-2 border-b bg-muted/30 p-4" onsubmit={(event) => { event.preventDefault(); connect.mutate(); }}>
			<p class="text-sm">Connect to your real conversations on this device. Create a token in Beeper Settings → Integrations → Approved connections. It is stored in the device keychain.</p>
			<label for="beeper-token" class="text-sm">Beeper access token</label>
			<div class="flex gap-2"><Input id="beeper-token" type="password" autocomplete="off" placeholder="Paste a new token, or use your saved connection" bind:value={token} /><Button type="submit" disabled={connect.isPending}>{connect.isPending ? 'Connecting…' : 'Connect to live Beeper'}</Button></div>
			<p class="text-xs text-muted-foreground">Live Beeper works when Messages runs on this computer (<code>bun run --cwd apps/messages start</code>), which keeps the token in the device keychain.</p>
		</form>
	{/if}
	{#if notice}<p role="alert" class="border-b p-3 text-sm text-destructive">{notice}</p>{/if}
	{#if backend.mode === 'demo'}
		<div class="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-xs text-muted-foreground">
			<span>No real accounts are connected. Replies stay in this demo.</span>
			<Button variant="ghost" size="sm" onclick={() => { demo.incoming(); void queryClient.invalidateQueries({ queryKey: ['beeper'] }); }}>Simulate incoming</Button>
			<Button variant="ghost" size="sm" onclick={() => { demo.failNext(); notice = 'The next demo send will have an unknown outcome.'; }}>Simulate send failure</Button>
		</div>
	{/if}
	<div class="flex min-h-0 flex-1">
		<aside class="w-full min-w-0 flex-col border-r md:flex md:w-80 md:shrink-0" class:hidden={selected !== undefined} class:flex={selected === undefined} aria-label="Conversations">
			<div class="p-3"><Input aria-label="Filter conversations" placeholder="Find a conversation…" bind:value={filter} /></div>
			<div class="min-h-0 flex-1 overflow-y-auto">
				{#if chats.isPending}<Loading label="Loading conversations…" />{/if}
				{#if chats.error}<p role="alert" class="p-3 text-sm text-destructive">{chats.error.message}</p>{/if}
				{#each visible as chat (chat.id)}
					{@const draft = draftPreviews.get(chat.id)}
					<button class="block w-full border-b px-4 py-3 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring" class:bg-accent={selected === chat.id} aria-current={selected === chat.id ? 'true' : undefined} onclick={() => { selected = chat.id; }}>
						<div class="flex items-baseline justify-between gap-2"><span class="truncate text-sm font-medium">{chat.title}</span><span class="shrink-0 text-xs text-muted-foreground">{chat.network}</span></div>
						<p class="truncate text-xs text-muted-foreground">{#if draft}<span class="font-medium text-primary">{draft.label}:</span> {draft.text}{:else}{chat.preview || 'No message preview'}{/if}</p>
					</button>
				{/each}
				{#if !chats.isPending && !chats.error && visible.length === 0}<p class="p-4 text-sm text-muted-foreground">{filter ? 'No matching conversations in the loaded chats.' : 'No conversations available.'}</p>{/if}
				{#if chats.hasNextPage}<Button class="m-3" variant="outline" size="sm" disabled={chats.isFetchingNextPage} onclick={() => void chats.fetchNextPage()}>Load more conversations</Button>{/if}
			</div>
		</aside>
		<div class="min-h-0 min-w-0 flex-1 md:block" class:hidden={selected === undefined}>
			{#if current}
				{#key `${backend.mode}:${backend.profile}:${current.id}`}<ConversationView {backend} chat={current} onBack={() => { selected = undefined; }} />{/key}
			{:else}<Empty.Root class="h-full"><Empty.Title>Choose a conversation</Empty.Title><Empty.Description>Read and reply through Beeper.</Empty.Description></Empty.Root>{/if}
		</div>
	</div>
</main>
