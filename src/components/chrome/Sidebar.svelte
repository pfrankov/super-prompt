<script lang="ts">
  import { _ } from 'svelte-i18n'
  import { route, navigate } from '../../stores/router'
  import LanguageSwitcher from './LanguageSwitcher.svelte'
  import Tag from '../ui/Tag.svelte'

  let { onCreateTask, mobileOpen = false }: { onCreateTask?: () => void; mobileOpen?: boolean } = $props()

  function close() {
    // Fire a custom event the parent can listen to (AppShell) to close the drawer
    window.dispatchEvent(new CustomEvent('sp:closeSidebar'))
  }

  function go(path: string) {
    navigate(path)
    close()
  }
</script>

<aside class="sidebar">
  <div class="brand">
    <svg class="logo" viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="#25201a"/>
      <path d="M8 22 L16 6 L24 22 Z" fill="none" stroke="#f6c89f" stroke-width="2" stroke-linejoin="round"/>
      <circle cx="16" cy="18" r="2" fill="#f3b8b3"/>
    </svg>
    <div class="brand-text">
      <h1>{$_('app.title')}</h1>
      <span class="subtitle">{$_('app.subtitle')}</span>
    </div>
  </div>

  <nav>
    <button
      type="button"
      class="nav-item"
      class:active={$route.name === 'home'}
      onclick={() => go('/')}
    >
      <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
        <path d="M3 4h14M3 10h14M3 16h14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/>
      </svg>
      <span>{$_('nav.tasks')}</span>
    </button>
    <button
      type="button"
      class="nav-item"
      class:active={$route.name === 'settings'}
      onclick={() => go('/settings')}
    >
      <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
        <circle cx="10" cy="10" r="2.5" stroke="currentColor" stroke-width="1.5" fill="none"/>
        <path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.2 4.2l1.4 1.4M14.4 14.4l1.4 1.4M4.2 15.8l1.4-1.4M14.4 5.6l1.4-1.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
      <span>{$_('nav.settings')}</span>
    </button>
  </nav>

  <div class="grow"></div>

  {#if $route.name === 'home'}
    <button type="button" class="new-task" onclick={() => onCreateTask?.()}>
      <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
        <path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
      <span>{$_('nav.newTask')}</span>
    </button>
  {/if}

  <div class="footer">
    <LanguageSwitcher />
    <Tag tone="neutral">{$_('sidebar.version')}</Tag>
  </div>
</aside>

<style>
  .sidebar {
    width: 244px;
    background: color-mix(in srgb, var(--bg-1) 92%, black);
    border-right: 1px solid var(--border-1);
    display: flex;
    flex-direction: column;
    padding: var(--s-5) var(--s-4);
    gap: var(--s-4);
    height: 100dvh;
    position: sticky;
    top: 0;
  }
  .brand { display: flex; gap: var(--s-3); align-items: center; padding: var(--s-1) var(--s-2) var(--s-3); border-bottom: 1px solid var(--border-1); }
  .logo { flex: 0 0 auto; }
  .brand-text h1 {
    font-size: var(--fs-lg);
    margin: 0;
    line-height: 1.1;
    letter-spacing: 0;
  }
  .subtitle {
    font-size: var(--fs-xs);
    color: var(--ink-3);
  }
  nav { display: flex; flex-direction: column; gap: 2px; margin-top: var(--s-2); }
  .nav-item {
    appearance: none;
    background: transparent;
    border: none;
    color: var(--ink-3);
    padding: 10px var(--s-3);
    border-radius: var(--r-md);
    font: inherit;
    font-size: var(--fs-sm);
    text-align: left;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: var(--s-3);
    transition:
      background var(--dur-fast) var(--ease),
      color var(--dur-fast) var(--ease),
      transform var(--dur-fast) var(--ease);
  }
  .nav-item:hover { background: var(--bg-2); color: var(--ink-1); transform: translateX(1px); }
  .nav-item.active { background: var(--bg-2); color: var(--ink-1); box-shadow: inset 0 0 0 1px var(--border-1); }
  .nav-item:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
  .grow { flex: 1 1 auto; }
  .new-task {
    appearance: none;
    background: var(--primary);
    color: var(--primary-fg);
    border: none;
    border-radius: var(--r-md);
    padding: var(--s-3);
    font: inherit;
    font-size: var(--fs-sm);
    font-weight: 500;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--s-2);
    transition:
      background var(--dur-fast) var(--ease),
      box-shadow var(--dur-fast) var(--ease),
      transform var(--dur-fast) var(--ease);
  }
  .new-task:hover { background: var(--primary-hover); box-shadow: var(--shadow-glow); transform: translateY(-1px); }
  .new-task:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
  .footer { display: flex; align-items: center; justify-content: space-between; padding: var(--s-2); }
</style>
