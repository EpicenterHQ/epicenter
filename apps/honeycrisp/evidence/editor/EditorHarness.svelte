<script lang="ts">
 import * as Tooltip from '@epicenter/ui/tooltip';
 import type * as Y from '@y/y';
 import Editor from '../../src/lib/editor/Editor.svelte';
 let { body }: { body: Y.Node } = $props();
</script>
<Tooltip.Provider>
 <Editor yxmlfragment={body} focusRequest={0} />
</Tooltip.Provider>
