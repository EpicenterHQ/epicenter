import { mount, unmount } from 'svelte';
import App from './App.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('AppBoot fixture mount target is missing.');
const app = mount(App, { target });
Reflect.set(window, 'destroyBoot', () => unmount(app));
