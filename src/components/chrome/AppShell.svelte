<script lang="ts">
  import type { Snippet } from 'svelte'
  import { onMount } from 'svelte'
  import { _ } from 'svelte-i18n'
  import Sidebar from './Sidebar.svelte'
  import Toaster from './Toaster.svelte'
  import Drawer from '../ui/Drawer.svelte'
  import Button from '../ui/Button.svelte'

  let { onCreateTask, children }: { onCreateTask?: () => void; children?: Snippet } = $props()

  let drawerOpen = $state(false)

  onMount(() => {
    const onClose = () => (drawerOpen = false)
    window.addEventListener('sp:closeSidebar', onClose)
    return () => window.removeEventListener('sp:closeSidebar', onClose)
  })
</script>

<a class="skip" href="#main">Skip to main content</a>

<div class="shell">
  <div class="desktop-only">
    <Sidebar {onCreateTask} />
  </div>

  <main id="main">
    <div class="mobile-bar">
      <Button size="sm" variant="ghost" onclick={() => (drawerOpen = true)} aria-label="Open menu">
        <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
          <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/>
        </svg>
      </Button>
    </div>
    {#if children}{@render children()}{/if}
  </main>
  <Toaster />
</div>

<Drawer bind:open={drawerOpen} title={$_('app.title')}>
  <div class="drawer-side">
    <Sidebar {onCreateTask} />
  </div>
</Drawer>

<style>
  .shell {
    display: grid;
    grid-template-columns: 244px minmax(0, 1fr);
    min-height: 100dvh;
  }
  main {
    min-width: 0;
    padding: var(--s-6) clamp(var(--s-5), 3vw, var(--s-12));
    background: transparent;
  }
  .desktop-only { display: block; }
  .mobile-bar { display: none; margin-bottom: var(--s-3); }
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
  .drawer-side :global(.sidebar) {
    position: static;
    height: auto;
    width: 100%;
    border-right: none;
  }
  @media (max-width: 720px) {
    .shell { grid-template-columns: 1fr; }
    main { padding: var(--s-4); }
    .desktop-only { display: none; }
    .mobile-bar { display: block; }
  }
</style>
