import { mount } from 'svelte';
import './style.css';
import Harness from './Harness.svelte';

mount(Harness, { target: document.getElementById('app')! });
