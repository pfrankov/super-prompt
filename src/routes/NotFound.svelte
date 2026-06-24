<script lang="ts">
  import { _ } from 'svelte-i18n'
  import { navigate } from '../stores/router'
  import Button from '../components/ui/Button.svelte'
</script>

<div class="wrap">
  <h1>404</h1>
  <p class="muted">{$_('common.empty')}</p>
  <Button variant="secondary" onclick={() => navigate('/')}>{$_('common.back')}</Button>
</div>

<style>
  .wrap {
    padding: var(--s-16) var(--s-8);
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--s-3);
  }
  h1 { font-size: 64px; color: var(--ink-3); margin: 0; }
  .muted { color: var(--ink-3); }
</style>
