import { describe, expect, it } from 'vitest'
import { asNodeId } from '../../shared/ids'
import { baseHandle } from './handles'
import { HandleNames, isHandleOf } from './transcript-names'

const TESSA = asNodeId('c35ae62d-aa5a-46d1-8e03-086f95cd612e')
const OLIVER = asNodeId('255818c9-5dfd-47a4-96dd-6d62209751df')

describe('HandleNames', () => {
  it('learns a name from wherever the record wrote it beside the handle', () => {
    const names = new HandleNames()
    names.learn('{"say":[{"from":"Ivy:frost-jaguar","text":"Done."}]}\nUNARCHIVED {Max:steady-tulip}')
    expect(names.resolve('frost-jaguar')).toBe('Ivy')
    expect(names.resolve('steady-tulip')).toBe('Max')
    expect(names.resolve('keen-barn')).toBeUndefined()
  })

  it('learns names of nodes from logged events, for their word handle and the hex one before it', () => {
    const names = new HandleNames()
    names.learn(`{"event":"sent","nodeId":"${OLIVER}","name":"Oliver","message":"hi"}`)
    expect(names.resolve(baseHandle(OLIVER))).toBe('Oliver')
    expect(names.resolve('a255818')).toBe('Oliver')
  })

  it('takes the name the registry holds now over an old one', () => {
    const names = new HandleNames()
    names.learn(`{Tess:${baseHandle(TESSA)}}`)
    names.learnNode(TESSA, 'Tessa')
    expect(names.resolve(baseHandle(TESSA))).toBe('Tessa')
  })
})

describe('isHandleOf', () => {
  it('matches the word pair, a collision suffix, and the old hex handle', () => {
    expect(isHandleOf(TESSA, baseHandle(TESSA))).toBe(true)
    expect(isHandleOf(TESSA, `${baseHandle(TESSA)}-2`)).toBe(true)
    expect(isHandleOf(TESSA, 'ac35ae6')).toBe(true)
    expect(isHandleOf(OLIVER, 'ac35ae6')).toBe(false)
  })
})
