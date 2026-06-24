<script lang="ts">
  let {
    value = $bindable(''),
    label,
    placeholder = '',
    hint = '',
    error = '',
    disabled = false,
    readonly = false,
    rows = 4,
    id = '',
    name = '',
    onchange,
    oninput,
    monospace = false,
    autoresize = true,
  }: {
    value?: string
    label?: string
    placeholder?: string
    hint?: string
    error?: string
    disabled?: boolean
    readonly?: boolean
    rows?: number
    id?: string
    name?: string
    onchange?: (v: string) => void
    oninput?: (v: string) => void
    monospace?: boolean
    autoresize?: boolean
  } = $props()

  const autoId = $props.id()
  const fieldId = $derived(id || `ta-${autoId}`)
  let ta: HTMLTextAreaElement | null = $state(null)

  $effect(() => {
    if (autoresize && ta) {
      ta.style.height = 'auto'
      ta.style.height = ta.scrollHeight + 'px'
    }
  })
</script>

<label class="field" for={fieldId}>
  {#if label}<span class="label">{label}</span>{/if}
  <textarea
    bind:this={ta}
    bind:value
    {placeholder}
    {disabled}
    {readonly}
    {rows}
    {name}
    id={fieldId}
    class:mono={monospace}
    aria-describedby={error ? `${fieldId}-err` : hint ? `${fieldId}-hint` : undefined}
    aria-invalid={!!error}
    onchange={() => onchange?.(value)}
    oninput={() => oninput?.(value)}
  ></textarea>
  {#if error}
    <span id="{fieldId}-err" class="error" role="alert">{error}</span>
  {:else if hint}
    <span id="{fieldId}-hint" class="hint">{hint}</span>
  {/if}
</label>

<style>
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    min-width: 0;
  }
  .label {
    font-size: var(--fs-sm);
    font-weight: 500;
    color: var(--ink-2);
  }
  textarea {
    appearance: none;
    background: color-mix(in srgb, var(--bg-2) 78%, black);
    border: 1px solid var(--border-1);
    border-radius: var(--r-md);
    padding: var(--s-3);
    color: var(--ink-1);
    font: inherit;
    line-height: var(--lh-base);
    transition:
      border-color var(--dur-fast) var(--ease),
      background-color var(--dur-fast) var(--ease),
      box-shadow var(--dur-fast) var(--ease);
    resize: vertical;
    width: 100%;
    min-height: 80px;
  }
  textarea.mono { font-family: var(--font-mono); font-size: var(--fs-sm); }
  textarea::placeholder { color: var(--ink-3); }
  textarea:hover:not(:disabled):not(:focus) {
    background: color-mix(in srgb, var(--bg-2) 88%, black);
    border-color: var(--border-2);
  }
  textarea:focus {
    outline: none;
    border-color: rgba(238, 183, 124, 0.65);
    box-shadow: 0 0 0 3px rgba(238, 183, 124, 0.11);
  }
  textarea[aria-invalid="true"] { border-color: var(--err); }
  textarea:disabled { opacity: 0.5; cursor: not-allowed; }
  .hint { font-size: var(--fs-xs); color: var(--ink-3); }
  .error { font-size: var(--fs-xs); color: var(--err); }
</style>
