import { mount } from 'svelte'
import App from './App.svelte'
import './app.css'
import { initI18n } from './lib/i18n'
import { loadSettings } from './stores/settings'

async function boot() {
  await loadSettings()
  await initI18n()
  const app = mount(App, { target: document.getElementById('app')! })
  return app
}

boot()
