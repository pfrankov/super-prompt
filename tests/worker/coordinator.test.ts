import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  getRun: vi.fn(), getCandidates: vi.fn(), getIterations: vi.fn(), addCandidate: vi.fn(), patchRun: vi.fn(), getTask: vi.fn(), getDataset: vi.fn(), getAllItems: vi.fn(), getSettings: vi.fn(), createRunner: vi.fn(), comparePrompts: vi.fn(),
}))
vi.mock('../../src/lib/db/runs', () => mocks)
vi.mock('../../src/lib/db/tasks', () => mocks)
vi.mock('../../src/lib/db/datasets', () => mocks)
vi.mock('../../src/lib/db/settings', () => mocks)
vi.mock('../../src/worker/loop', () => mocks)
let worker: { postMessage: ReturnType<typeof vi.fn>; onmessage: (event: {data: unknown}) => Promise<void> }
const config = { iterationsCap: 3 }
const send = (data: unknown) => worker.onmessage({data})
beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  worker = { postMessage: vi.fn(), onmessage: async () => {} }
  vi.stubGlobal('self', worker)
  mocks.getRun.mockImplementation(async (id) => ({ id, taskId: id === 'run-a' ? 'a' : 'b', config, status: 'idle' }))
  mocks.getTask.mockImplementation(async (id) => ({ id, datasetId: `${id}-dataset`, initialPrompt: 'prompt', seedPrompts: [] }))
  mocks.getDataset.mockImplementation(async (id) => ({id}))
  mocks.getAllItems.mockImplementation(async (id) => [{id:`${id}-1`},{id:`${id}-2`}])
  mocks.getSettings.mockResolvedValue({provider:{id:'current'},arbitrator:{enabled:false}})
  mocks.getCandidates.mockResolvedValue([])
  mocks.getIterations.mockResolvedValue([])
  mocks.comparePrompts.mockResolvedValue([])
  mocks.createRunner.mockReturnValue({start:vi.fn().mockResolvedValue(undefined),snapshot:()=>({run:{status:'completed'}}),getCtx:()=>({task:{id:'stale-a'}})})
  await import('../../src/worker/optimizer.worker')
})
describe('worker request coordination', () => {
  it('loads the requested task and current settings for comparison after an earlier run', async () => {
    await send({type:'START',payload:{runId:'run-a'}})
    await send({type:'COMPARE_AB',payload:{requestId:7,taskId:'b',promptA:'A',promptB:'B',itemIds:['b-dataset-1'],config}})
    expect(mocks.comparePrompts).toHaveBeenCalledWith(expect.objectContaining({task:{id:'b',datasetId:'b-dataset',initialPrompt:'prompt',seedPrompts:[]},provider:{id:'current'}}),'A','B',['b-dataset-1'])
    expect(worker.postMessage).toHaveBeenCalledWith({type:'COMPARE_RESULT',requestId:7,results:[]})
  })
  it('ignores duplicate starts while data is still loading', async () => {
    let release!: (value: unknown) => void
    mocks.getRun.mockReturnValueOnce(new Promise((resolve)=>{release=resolve}))
    const first = send({type:'START',payload:{runId:'run-a'}})
    await send({type:'START',payload:{runId:'run-b'}})
    release({id:'run-a',taskId:'a',config,status:'idle'})
    await first
    expect(mocks.createRunner).toHaveBeenCalledTimes(1)
  })
  it('stop during startup prevents creating a runner', async () => {
    let release!: (value: unknown) => void
    mocks.getRun.mockReturnValueOnce(new Promise((resolve)=>{release=resolve}))
    const first = send({type:'START',payload:{runId:'run-a'}})
    await send({type:'STOP',payload:{runId:'run-a'}})
    release({id:'run-a',taskId:'a',config,status:'idle'})
    await first
    expect(mocks.createRunner).not.toHaveBeenCalled()
    expect(mocks.patchRun).toHaveBeenCalledWith('run-a',expect.objectContaining({status:'stopped'}))
  })
})

it('releases execution ownership after startup persistence fails', async () => {
  const broken = { start: vi.fn().mockRejectedValue(new Error('Transient DB error')), snapshot: () => ({run:{status:'running'}}) }
  mocks.createRunner.mockReturnValueOnce(broken)
  await send({type:'START',payload:{runId:'run-a'}})
  expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({type:'ERROR',message:'Transient DB error'}))
  await send({type:'START',payload:{runId:'run-b'}})
  expect(mocks.createRunner).toHaveBeenCalledTimes(2)
})
