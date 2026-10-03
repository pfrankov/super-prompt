<script lang="ts">
  import type { Snippet } from 'svelte'
  import Sidebar from './Sidebar.svelte'
  import Toaster from './Toaster.svelte'
  import { route } from '../../stores/router'

  let { children }: { onCreateTask?: () => void; children?: Snippet } = $props()
</script>

<a class="skip" href="#main" onclick={(e) => { e.preventDefault(); document.getElementById('main')?.focus() }}>Skip to main content</a>

<div class="shell">
  {#if $route.name !== 'task'}<Sidebar />{/if}
  <main id="main" tabindex="-1">
    {#if children}{@render children()}{/if}
  </main>
  <Toaster />
</div>

<style>
  .shell { min-height: 100dvh; }
  main {
    width: 100%;
    max-width: calc(var(--canvas-width) + var(--page-gutter) * 2);
    min-width: 0;
    margin: 0 auto;
    padding: 24px var(--page-gutter) 64px;
  }
  .skip {
    position: absolute;
    left: -10000px;
    top: auto;
    width: 1px;
    height: 1px;
    overflow: hidden;
  }
  .skip:focus {
    position: fixed;
    left: var(--s-3);
    top: var(--s-3);
    width: auto;
    height: auto;
    padding: var(--s-2) var(--s-3);
    background: var(--bg-1);
    color: var(--ink-1);
    border: 2px solid var(--primary);
    border-radius: var(--r-md);
    z-index: var(--z-overlay);
  }
  @media (max-width: 600px) {
    main { padding-top: 28px; padding-bottom: 40px; }
  }
</style>
