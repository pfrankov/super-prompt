<script lang="ts">
  import { onMount } from 'svelte'
  import type { Snippet } from 'svelte'

  let {
    text,
    children,
    placement = 'top',
  }: { text: string; children: Snippet; placement?: 'top' | 'bottom' } = $props()

  const autoId = $props.id()
  const tipId = $derived(`ttip-${autoId}`)
  let anchor: HTMLSpanElement | null = $state(null)
  let left = $state(0)
  let top = $state(0)
  let maxWidth = $state(320)
  let frame = 0

  function updatePosition() {
    if (!anchor || typeof window === 'undefined') return
    const rect = anchor.getBoundingClientRect()
    maxWidth = Math.min(320, window.innerWidth - 24)
    const half = maxWidth / 2
    left = Math.min(window.innerWidth - half - 12, Math.max(half + 12, rect.left + rect.width / 2))
    top = placement === 'bottom' ? rect.bottom + 8 : rect.top - 8
  }

  function scheduleUpdate() {
    if (frame || typeof window === 'undefined') return
    frame = window.requestAnimationFrame(() => {
      frame = 0
      updatePosition()
    })
  }

  function track(node: HTMLSpanElement) {
    anchor = node
    node.addEventListener('mouseenter', updatePosition)
    node.addEventListener('mousemove', scheduleUpdate)
    node.addEventListener('mousedown', updatePosition)
    node.addEventListener('click', updatePosition)
    node.addEventListener('focus', updatePosition, true)

    return {
      destroy() {
        node.removeEventListener('mouseenter', updatePosition)
        node.removeEventListener('mousemove', scheduleUpdate)
        node.removeEventListener('mousedown', updatePosition)
        node.removeEventListener('click', updatePosition)
        node.removeEventListener('focus', updatePosition, true)
      },
    }
  }

  onMount(() => {
    scheduleUpdate()
    window.addEventListener('resize', scheduleUpdate)
    window.addEventListener('scroll', scheduleUpdate, true)

    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', scheduleUpdate)
      window.removeEventListener('scroll', scheduleUpdate, true)
    }
  })
</script>

<span
  use:track
  class="wrap"
  role="group"
  style={`--tt-left: ${left}px; --tt-top: ${top}px; --tt-max-width: ${maxWidth}px;`}
>
  {@render children()}
  <span id={tipId} class="tip {placement}" role="tooltip">{text}</span>
</span>

<style>
  .wrap {
    position: relative;
    display: inline-flex;
  }
  .tip {
    position: fixed;
    left: var(--tt-left);
    top: var(--tt-top);
    width: max-content;
    max-width: var(--tt-max-width);
    background: var(--bg-elevated);
    color: var(--ink-1);
    border: 1px solid var(--border-2);
    padding: 7px 9px;
    border-radius: var(--r-sm);
    font-size: var(--fs-xs);
    line-height: 1.4;
    white-space: normal;
    text-align: left;
    z-index: var(--z-toast);
    pointer-events: none;
    box-shadow: var(--shadow-2);
    opacity: 0;
    visibility: hidden;
    transition:
      opacity 120ms var(--ease-out),
      visibility 0ms linear 120ms,
      transform 120ms var(--ease-out);
  }
  .top {
    transform: translateX(-50%) translateY(calc(-100% + 2px));
  }
  .bottom {
    transform: translateX(-50%) translateY(-2px);
  }
  .wrap:hover .tip,
  .wrap:focus-within .tip {
    opacity: 1;
    visibility: visible;
    transition-delay: 0ms;
  }
  .wrap:hover .top,
  .wrap:focus-within .top {
    transform: translateX(-50%) translateY(-100%);
  }
  .wrap:hover .bottom,
  .wrap:focus-within .bottom {
    transform: translateX(-50%) translateY(0);
  }
</style>
