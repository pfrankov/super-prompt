import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [svelte()],
  // Components run in jsdom; see https://svelte.dev/docs/svelte/testing.
  // Select public browser exports rather than importing framework internals.
  resolve: { conditions: ['browser'], alias: { 'svelte-i18n': fileURLToPath(new URL('./src/lib/i18n/index.ts', import.meta.url)) } },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/**/*.test.ts'],
    maxWorkers: 2,
  },
})