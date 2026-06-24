import { openDB, type IDBPDatabase, type DBSchema } from 'idb'
import type {
  Task,
  Dataset,
  DatasetItem,
  Run,
  PromptCandidate,
  IterationRecord,
  PairwiseResult,
  AppSettings,
} from '../types'

const DB_NAME = 'super-prompt'
const DB_VERSION = 1

export interface SPDB extends DBSchema {
  tasks: {
    key: string
    value: Task
    indexes: { 'by-updatedAt': number }
  }
  datasets: {
    key: string
    value: Dataset
    indexes: { 'by-taskId': string }
  }
  datasets_items: {
    key: string
    value: DatasetItem
    indexes: { 'by-datasetId': string }
  }
  runs: {
    key: string
    value: Run
    indexes: { 'by-taskId': string; 'by-status': string }
  }
  candidates: {
    key: string
    value: PromptCandidate
    indexes: { 'by-runId': string; 'by-runId-score': [string, number] }
  }
  iterations: {
    key: string
    value: IterationRecord
    indexes: { 'by-runId': string; 'by-runId-index': [string, number] }
  }
  pairs: {
    key: string
    value: PairwiseResult
    indexes: { 'by-iterationId': string }
  }
  settings: {
    key: string
    value: AppSettings & { id: string }
  }
}

let dbPromise: Promise<IDBPDatabase<SPDB>> | null = null

export function db(): Promise<IDBPDatabase<SPDB>> {
  if (!dbPromise) {
    dbPromise = openDB<SPDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const tasks = db.createObjectStore('tasks', { keyPath: 'id' })
        tasks.createIndex('by-updatedAt', 'updatedAt')

        const datasets = db.createObjectStore('datasets', { keyPath: 'id' })
        datasets.createIndex('by-taskId', 'taskId')

        const items = db.createObjectStore('datasets_items', { keyPath: 'id' })
        items.createIndex('by-datasetId', 'datasetId')

        const runs = db.createObjectStore('runs', { keyPath: 'id' })
        runs.createIndex('by-taskId', 'taskId')
        runs.createIndex('by-status', 'status')

        const candidates = db.createObjectStore('candidates', { keyPath: 'id' })
        candidates.createIndex('by-runId', 'runId')
        candidates.createIndex('by-runId-score', ['runId', 'score'])

        const iter = db.createObjectStore('iterations', { keyPath: 'id' })
        iter.createIndex('by-runId', 'runId')
        iter.createIndex('by-runId-index', ['runId', 'index'])

        const pairs = db.createObjectStore('pairs', { keyPath: 'id' })
        pairs.createIndex('by-iterationId', 'iterationId')

        db.createObjectStore('settings', { keyPath: 'id' })
      },
    })
  }
  return dbPromise
}

export async function wipeAll(): Promise<void> {
  const d = await db()
  await Promise.all(
    (['tasks', 'datasets', 'datasets_items', 'runs', 'candidates', 'iterations', 'pairs'] as const).map(
      (s) => d.clear(s)
    )
  )
}