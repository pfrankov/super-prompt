<script lang="ts">
  import { settings, setLang } from '../../stores/settings'
</script>

<div class="switch" role="group" aria-label="Language">
  <button
    type="button"
    class:active={$settings.lang === 'en'}
    onclick={() => void setLang('en')}
    aria-pressed={$settings.lang === 'en'}
  >EN</button>
  <button
    type="button"
    class:active={$settings.lang === 'ru'}
    onclick={() => void setLang('ru')}
    aria-pressed={$settings.lang === 'ru'}
  >RU</button>
</div>

<style>
  .switch {
    display: inline-flex;
    background: var(--bg-2);
    border: 1px solid var(--border-1);
    border-radius: var(--r-pill);
    padding: 2px;
  }
  button {
    appearance: none;
    background: transparent;
    border: none;
    color: var(--ink-3);
    padding: 4px 12px;
    border-radius: var(--r-pill);
    font: inherit;
    font-size: var(--fs-xs);
    font-weight: 600;
    letter-spacing: 0.04em;
    cursor: pointer;
    transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
  }
  button:hover { color: var(--ink-2); }
  button.active { background: var(--bg-elevated); color: var(--ink-1); box-shadow: var(--shadow-1); }
</style>
