import { describe, expect, it } from 'vitest'
import { toPlainDatasetItem, toPlainDatasetItemInput } from '../../src/lib/db/datasets'

function proxied<T extends object>(value: T): T {
  return new Proxy(value, {
    get(target, prop, receiver) {
      return Reflect.get(target, prop, receiver)
    },
  })
}

describe('dataset item persistence helpers', () => {
  it('converts proxied dataset input rows into structured-cloneable plain objects', () => {
    const row = proxied({
      input: 'long input',
      expectedOutput: 'short summary',
      meta: proxied({ difficulty: 'hard', source: 'import' }),
    })

    expect(() => structuredClone(row)).toThrow()

    const plain = toPlainDatasetItemInput(row)

    expect(plain).toEqual({
      input: 'long input',
      expectedOutput: 'short summary',
      meta: { difficulty: 'hard', source: 'import' },
    })
    expect(structuredClone(plain)).toEqual(plain)
  })

  it('converts complete dataset items into structured-cloneable plain objects', () => {
    const item = proxied({
      id: 'item-1',
      datasetId: 'dataset-1',
      input: 'input',
      expectedOutput: undefined,
      meta: proxied({ touched: 'manual' }),
    })

    const plain = toPlainDatasetItem(item)

    expect(plain).toEqual({
      id: 'item-1',
      datasetId: 'dataset-1',
      input: 'input',
      expectedOutput: undefined,
      meta: { touched: 'manual' },
    })
    expect(structuredClone(plain)).toEqual(plain)
  })
})
