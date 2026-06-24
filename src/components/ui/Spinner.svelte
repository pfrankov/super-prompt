<script lang="ts">
  let { size = 16, label = '' }: { size?: number; label?: string } = $props()
</script>

<span class="spinner" style="--s: {size}px" role="status" aria-label={label || 'Loading'}>
  <span class="dot d1"></span>
  <span class="dot d2"></span>
  <span class="dot d3"></span>
</span>

<style>
  .spinner { display: inline-flex; gap: 4px; align-items: center; }
  .dot {
    width: calc(var(--s) / 3);
    height: calc(var(--s) / 3);
    border-radius: 50%;
    background: currentColor;
    opacity: 0.3;
    animation: pulse 1.2s var(--ease) infinite;
  }
  .d2 { animation-delay: 0.15s; }
  .d3 { animation-delay: 0.3s; }
  @keyframes pulse {
    0%, 60%, 100% { opacity: 0.3; transform: scale(0.8); }
    30% { opacity: 1; transform: scale(1); }
  }
</style>
