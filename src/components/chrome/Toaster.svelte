<script lang="ts">
  import { toasts } from '../../stores/toast'
</script>

<div class="host" role="region" aria-label="Notifications" aria-live="polite">
  {#each $toasts as t (t.id)}
    <div class="toast {t.level}" role={t.level === 'error' ? 'alert' : 'status'}>
      <span class="msg">{t.msg}</span>
    </div>
  {/each}
</div>

<style>
  .host {
    position: fixed;
    bottom: var(--s-4);
    right: var(--s-4);
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    z-index: var(--z-toast);
    pointer-events: none;
  }
  .toast {
    pointer-events: auto;
    background: var(--bg-elevated);
    border: 1px solid var(--border-2);
    border-radius: var(--r-md);
    padding: var(--s-3) var(--s-4);
    color: var(--ink-1);
    font-size: var(--fs-sm);
    max-width: 360px;
    box-shadow: var(--shadow-3);
    animation: slideIn var(--dur-base) var(--ease-out);
  }
  .info { border-left: 3px solid var(--info); }
  .success { border-left: 3px solid var(--ok); }
  .warn { border-left: 3px solid var(--warn); }
  .error { border-left: 3px solid var(--err); }
  @keyframes slideIn {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>
