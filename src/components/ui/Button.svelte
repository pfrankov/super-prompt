<script lang="ts">
  import type { Snippet } from 'svelte'

  type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
  type Size = 'sm' | 'md' | 'lg'

  let {
    variant = 'primary',
    size = 'md',
    type = 'button',
    disabled = false,
    loading = false,
    href = undefined as string | undefined,
    onclick = undefined as ((e: MouseEvent) => void) | undefined,
    children,
    icon,
    full = false,
    title = undefined as string | undefined,
    'aria-label': ariaLabel = undefined as string | undefined,
  }: {
    variant?: Variant
    size?: Size
    type?: 'button' | 'submit' | 'reset'
    disabled?: boolean
    loading?: boolean
    href?: string
    onclick?: (e: MouseEvent) => void
    children?: Snippet
    icon?: Snippet
    full?: boolean
    title?: string
    'aria-label'?: string
  } = $props()
</script>

{#if href}
  <a
    {href}
    class="btn"
    class:primary={variant === 'primary'}
    class:secondary={variant === 'secondary'}
    class:ghost={variant === 'ghost'}
    class:danger={variant === 'danger'}
    class:sm={size === 'sm'}
    class:md={size === 'md'}
    class:lg={size === 'lg'}
    class:full
    role="button"
    {title}
    aria-label={ariaLabel}
  >
    {#if icon}<span class="icon">{@render icon()}</span>{/if}
    {#if children}<span class="label">{@render children()}</span>{/if}
  </a>
{:else}
  <button
    {type}
    {title}
    aria-label={ariaLabel}
    class="btn"
    class:primary={variant === 'primary'}
    class:secondary={variant === 'secondary'}
    class:ghost={variant === 'ghost'}
    class:danger={variant === 'danger'}
    class:sm={size === 'sm'}
    class:md={size === 'md'}
    class:lg={size === 'lg'}
    class:full
    class:loading
    disabled={disabled || loading}
    {onclick}
  >
    {#if loading}
      <span class="spinner" aria-hidden="true"></span>
    {:else if icon}
      <span class="icon">{@render icon()}</span>
    {/if}
    {#if children}<span class="label">{@render children()}</span>{/if}
  </button>
{/if}

<style>
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--s-2);
    border-radius: var(--r-md);
    border: 1px solid transparent;
    font-weight: 500;
    letter-spacing: 0;
    transition:
      background-color var(--dur-fast) var(--ease),
      color var(--dur-fast) var(--ease),
      border-color var(--dur-fast) var(--ease),
      box-shadow var(--dur-fast) var(--ease),
      transform var(--dur-fast) var(--ease);
    user-select: none;
    white-space: nowrap;
    text-decoration: none;
    cursor: pointer;
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .btn:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: 2px;
  }
  .btn:not(:disabled):active {
    transform: translateY(1px) scale(0.99);
  }
  .full { width: 100%; }
  .label { display: inline-flex; align-items: center; }

  .sm { height: 32px; padding: 0 var(--s-3); font-size: var(--fs-sm); }
  .md { height: 38px; padding: 0 var(--s-4); font-size: var(--fs-sm); }
  .lg { height: 44px; padding: 0 var(--s-5); font-size: var(--fs-md); }

  .primary {
    background: var(--primary);
    color: var(--primary-fg);
  }
  .primary:not(:disabled):hover { background: var(--primary-hover); box-shadow: var(--shadow-glow); transform: translateY(-1px); }

  .secondary {
    background: color-mix(in srgb, var(--bg-2) 82%, var(--bg-3));
    color: var(--ink-1);
    border-color: var(--border-1);
  }
  .secondary:not(:disabled):hover { background: var(--bg-3); border-color: var(--border-2); transform: translateY(-1px); }

  .ghost {
    background: transparent;
    color: var(--ink-2);
  }
  .ghost:not(:disabled):hover { background: var(--bg-2); color: var(--ink-1); }

  .danger {
    background: rgba(243, 184, 179, 0.12);
    color: var(--err);
    border-color: rgba(243, 184, 179, 0.3);
  }
  .danger:not(:disabled):hover { background: rgba(243, 184, 179, 0.2); }

  .spinner {
    width: 14px; height: 14px;
    border: 2px solid currentColor;
    border-bottom-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
