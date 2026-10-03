<script lang="ts">
  import { _ } from 'svelte-i18n'
  import { route } from '../../stores/router'
  import LanguageSwitcher from './LanguageSwitcher.svelte'
</script>

<header class="app-header">
  <div class="header-inner">
    <a class="brand" href="#/">{$_('app.title')}</a>
    <nav aria-label={$_('app.title')}>
      <a
        class="nav-item"
        class:active={$route.name === 'home' || $route.name === 'task'}
        aria-current={$route.name === 'home' ? 'page' : undefined}
        href="#/"
      >{$_('nav.tasks')}</a>
      <a
        class="nav-item"
        class:active={$route.name === 'settings'}
        aria-current={$route.name === 'settings' ? 'page' : undefined}
        href="#/settings"
      >{$_('nav.settings')}</a>
    </nav>
    <div class="language"><LanguageSwitcher /></div>
  </div>
</header>

<style>
  .app-header { border-bottom: 1px solid var(--border-1); }
  .header-inner {
    display: flex;
    align-items: center;
    gap: 40px;
    min-height: 72px;
    width: 100%;
    max-width: calc(var(--canvas-width) + var(--page-gutter) * 2);
    margin: 0 auto;
    padding: 0 var(--page-gutter);
  }
  .brand {
    flex-shrink: 0;
    color: var(--ink-1);
    font-size: 19px;
    font-weight: 650;
    letter-spacing: -0.025em;
    line-height: 1.2;
    padding: 12px 0;
  }
  .brand:hover { text-decoration: none; }
  nav { display: flex; gap: 28px; align-self: stretch; }
  .nav-item {
    display: flex;
    align-items: center;
    min-height: 44px;
    color: var(--ink-3);
    font-size: var(--fs-sm);
    border-bottom: 1px solid transparent;
    padding: 2px 0 0;
  }
  .nav-item:hover { color: var(--ink-1); text-decoration: none; }
  .nav-item.active { color: var(--ink-1); border-bottom-color: var(--ink-2); }
  .language { margin-left: auto; }
  .language :global(.switch) { background: transparent; border: none; gap: 2px; padding: 0; }
  .language :global(button) { min-height: 36px; padding: 6px 8px; border-radius: 4px; }
  .language :global(button.active) { background: var(--bg-2); box-shadow: none; }
  @media (max-width: 600px) {
    .header-inner { gap: 22px; min-height: 64px; flex-wrap: wrap; row-gap: 0; }
    .brand { font-size: 17px; }
    nav { gap: 20px; order: 3; flex-basis: 100%; min-height: 42px; }
    .language { margin-left: auto; }
    .nav-item { font-size: var(--fs-sm); min-height: 42px; }
  }
</style>
