<script lang="ts">
	import * as Tabs from '@epicenter/ui/tabs';
	import ActivityFeed from '$lib/components/ActivityFeed.svelte';
	import ModelCostGuide from '$lib/components/ModelCostGuide.svelte';
	import TopModels from '$lib/components/TopModels.svelte';
	import UsageChart from '$lib/components/UsageChart.svelte';
</script>

<svelte:head><title>Usage: Epicenter</title></svelte:head>

<div class="mb-6 space-y-1">
	<h1 class="text-2xl font-semibold">Usage</h1>
	<p class="text-sm text-muted-foreground">Explore credit usage across your Epicenter apps.</p>
</div>

<Tabs.Root value="overview">
	<Tabs.List>
		<Tabs.Trigger value="overview">Overview</Tabs.Trigger>
		<Tabs.Trigger value="models">Model costs</Tabs.Trigger>
		<Tabs.Trigger value="activity">Activity</Tabs.Trigger>
	</Tabs.List>
	<Tabs.Content value="overview" class="pt-6">
		<UsageChart />
		<TopModels />
	</Tabs.Content>
	<Tabs.Content value="models" class="pt-6"><ModelCostGuide /></Tabs.Content>
	<Tabs.Content value="activity" class="pt-6"><ActivityFeed /></Tabs.Content>
</Tabs.Root>
