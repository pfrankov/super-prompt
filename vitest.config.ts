import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  plugins: [svelte()],
  // Components run in jsdom; see https://svelte.dev/docs/svelte/testing.
  // Select public browser exports rather than importing framework internals.
  resolve: { conditions: ['browser'] },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/**/*.test.ts'],
    maxWorkers: 2,
  },
})