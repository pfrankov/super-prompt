import { beforeEach, expect, it, vi } from 'vitest'
import { get, writable } from 'svelte/store'
vi.mock('../../src/stores/settings',()=>({settings:writable({provider:{},arbitrator:{}})}))
beforeEach(()=>{vi.resetModules();vi.unstubAllGlobals()})
it('rolls back the active run after worker construction fails so retry can start',async()=>{
  let fail=true
  const postMessage=vi.fn()
  vi.stubGlobal('Worker',class {onmessage:unknown;onerror:unknown;constructor(){if(fail)throw new Error('Worker unavailable')}postMessage=postMessage;terminate=vi.fn()})
  const store=await import('../../src/stores/worker')
  expect(()=>store.start('first')).toThrow('Worker unavailable')
  expect(get(store.activeRunId)).toBeNull()
  fail=false
  store.start('retry')
  expect(postMessage).toHaveBeenCalledWith({type:'START',payload:{runId:'retry'}})
})
it('rolls back failed message delivery and replaces the failed worker',async()=>{
  let created=0
  const terminated=vi.fn()
  vi.stubGlobal('Worker',class {onmessage:unknown;onerror:unknown;constructor(){created++}postMessage(){if(created===1)throw new Error('Delivery failed')}terminate=terminated})
  const store=await import('../../src/stores/worker')
  expect(()=>store.start('first')).toThrow('Delivery failed')
  expect(get(store.activeRunId)).toBeNull()
  store.start('retry')
  expect(created).toBe(2)
  expect(terminated).toHaveBeenCalledTimes(1)
})
