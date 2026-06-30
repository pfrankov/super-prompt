<script lang="ts">
  import { _ } from 'svelte-i18n'
  import { onDestroy, onMount } from 'svelte'

  let {
    points,
    width = 640,
    height = 200,
  }: { points: { iter: number; bestScore: number }[]; width?: number; height?: number } = $props()

  const padding = { top: 16, right: 16, bottom: 28, left: 36 }

  let wrapEl: HTMLDivElement | null = $state(null)
  let measuredWidth = $state(0)
  let ro: ResizeObserver | null = null

  const chartWidth = $derived(Math.max(320, measuredWidth || width))
  const innerW = $derived(chartWidth - padding.left - padding.right)
  const innerH = $derived(height - padding.top - padding.bottom)

  const maxIter = $derived(points.length > 0 ? points[points.length - 1].iter : 0)
  const maxScore = 10

  function xFor(iter: number) {
    if (points.length <= 1) return padding.left + innerW / 2
    return padding.left + (iter / maxIter) * innerW
  }
  function yFor(score: number) {
    return padding.top + innerH - (score / maxScore) * innerH
  }

  const linePath = $derived(
    points.length === 0
      ? ''
      : 'M ' + points.map((p) => `${xFor(p.iter)},${yFor(p.bestScore)}`).join(' L ')
  )

  let hover = $state<{ iter: number; bestScore: number; x: number; y: number } | null>(null)
  let svgEl: SVGSVGElement | null = $state(null)

  onMount(() => {
    const measure = () => {
      if (wrapEl) measuredWidth = Math.round(wrapEl.clientWidth)
    }
    measure()
    if (wrapEl && 'ResizeObserver' in window) {
      ro = new ResizeObserver(measure)
      ro.observe(wrapEl)
    }
  })

  onDestroy(() => {
    ro?.disconnect()
  })

  function onMove(e: MouseEvent) {
    if (!points.length || !svgEl) return
    const rect = svgEl.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * chartWidth
    // Find nearest point
    let best = points[0]
    let bestDist = Infinity
    for (const p of points) {
      const d = Math.abs(xFor(p.iter) - x)
      if (d < bestDist) { best = p; bestDist = d }
    }
    hover = { iter: best.iter, bestScore: best.bestScore, x: xFor(best.iter), y: yFor(best.bestScore) }
  }
  function onLeave() { hover = null }
</script>

<div class="chart-wrap" bind:this={wrapEl}>
  <svg
    bind:this={svgEl}
    viewBox="0 0 {chartWidth} {height}"
    role="img"
    aria-labelledby="chart-title chart-desc"
    onmousemove={onMove}
    onmouseleave={onLeave}
  >
    <title id="chart-title">{$_('chart.title')}</title>
    <desc id="chart-desc">Line chart of best score across iterations</desc>
    <rect x="0" y="0" width={chartWidth} height={height} fill="var(--bg-2)" rx="10" />

    <!-- gridlines -->
    {#each [0, 2, 4, 6, 8, 10] as g (g)}
      <line x1={padding.left} x2={padding.left + innerW} y1={yFor(g)} y2={yFor(g)} stroke="var(--border-1)" stroke-width="1" />
      <text x={padding.left - 6} y={yFor(g) + 4} text-anchor="end" font-size="10" fill="var(--ink-3)">{g}</text>
    {/each}

    <!-- x-axis labels -->
    {#if points.length > 0}
      <text x={padding.left} y={height - 6} font-size="10" fill="var(--ink-3)">0</text>
      <text x={padding.left + innerW / 2} y={height - 6} text-anchor="middle" font-size="10" fill="var(--ink-3)">{Math.round(maxIter / 2)}</text>
      <text x={padding.left + innerW} y={height - 6} text-anchor="end" font-size="10" fill="var(--ink-3)">{maxIter}</text>
    {/if}

    {#if points.length === 0}
      <text x={chartWidth / 2} y={height / 2} text-anchor="middle" font-size="12" fill="var(--ink-3)">{$_('chart.noData')}</text>
    {:else}
      <path d={linePath} fill="none" stroke="var(--primary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      {#each points as p (p.iter)}
        <circle cx={xFor(p.iter)} cy={yFor(p.bestScore)} r="3" fill="var(--primary)" />
      {/each}
    {/if}

    {#if hover}
      <line x1={hover.x} x2={hover.x} y1={padding.top} y2={padding.top + innerH} stroke="var(--border-2)" stroke-dasharray="2 2" />
      <circle cx={hover.x} cy={hover.y} r="5" fill="var(--primary)" stroke="var(--bg-1)" stroke-width="2" />
      <g transform="translate({Math.min(chartWidth - 130, Math.max(0, hover.x + 8))}, {Math.max(20, hover.y - 36)})">
        <rect width="120" height="32" rx="6" fill="var(--bg-elevated)" stroke="var(--border-2)" />
        <text x="10" y="14" font-size="10" fill="var(--ink-3)">{$_('chart.tooltipIter', { values: { n: hover.iter } })}</text>
        <text x="10" y="26" font-size="11" fill="var(--ink-1)" font-weight="600">{$_('chart.tooltipScore', { values: { s: hover.bestScore.toFixed(2) } })}</text>
      </g>
    {/if}
  </svg>
</div>

<style>
  .chart-wrap {
    width: 100%;
    height: 100%;
    min-height: 180px;
    border: 1px solid var(--border-1);
    border-radius: var(--r-md);
    overflow: hidden;
  }
  svg { display: block; width: 100%; height: 100%; }
</style>
