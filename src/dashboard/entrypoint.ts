import { mount } from 'svelte';

import Application from './application.svelte';

mount(Application, {
  target: document.getElementById('application')!,
});
