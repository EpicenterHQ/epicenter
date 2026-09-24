import { mount } from 'svelte';
import App from './App.svelte';
import '@epicenter/ui/app.css';

const configuration = await fetch('/fixture/config').then((response) =>
	response.json(),
);
mount(App, { target: document.getElementById('app')!, props: configuration });
