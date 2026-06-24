<script lang="ts">
  let {
    checked = $bindable(false),
    label,
    disabled = false,
    onchange,
  }: {
    checked?: boolean
    label?: string
    disabled?: boolean
    onchange?: (v: boolean) => void
  } = $props()
</script>

<label class="row">
  <span class="track" class:on={checked}>
    <input
      type="checkbox"
      bind:checked
      {disabled}
      onchange={() => onchange?.(checked)}
    />
    <span class="thumb"></span>
  </span>
  {#if label}<span class="label">{label}</span>{/if}
</label>

<style>
  .row { display: inline-flex; align-items: center; gap: var(--s-3); cursor: pointer; user-select: none; }
  .row:has(input:disabled) { opacity: 0.5; cursor: not-allowed; }
  .track {
    position: relative;
    width: 36px; height: 20px;
    background: var(--bg-3);
    border-radius: var(--r-pill);
    border: 1px solid var(--border-1);
    transition: background var(--dur-fast) var(--ease);
  }
  .track.on { background: var(--primary); border-color: transparent; }
  input {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
  }
  .thumb {
    position: absolute;
    top: 2px; left: 2px;
    width: 14px; height: 14px;
    background: var(--ink-1);
    border-radius: 50%;
    transition: transform var(--dur-fast) var(--ease);
    pointer-events: none;
  }
  .track.on .thumb { transform: translateX(16px); background: var(--primary-fg); }
  .label { font-size: var(--fs-md); color: var(--ink-2); }
</style>
