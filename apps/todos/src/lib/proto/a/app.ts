/**
 * PROTOTYPE option (a): the world as a module with a top-level await. Every
 * page that imports it waits for it; a failure rejects the importing route
 * module.
 */
import { openWorld } from '../open.js';

const world = await openWorld('a');

export const folder = world.folder;
export const todos = world.todos;
