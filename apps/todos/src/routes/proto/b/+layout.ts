// PROTOTYPE option (b): the world as the layout's load.
import { openWorld } from '$lib/proto/open.js';

export const load = async () => ({ world: await openWorld('b') });
