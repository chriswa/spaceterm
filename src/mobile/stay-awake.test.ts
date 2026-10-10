import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useReceptionistStore } from '@/stores/receptionistStore'
import { installStayAwake } from './stay-awake'

const PHONE = 'phone-device'
const phone = { deviceId: PHONE, label: 'Phone' }
const mac = { deviceId: 'mac-device', label: 'Mac' }

let posted: Array<Record<string, unknown>>
let uninstall: () => void

beforeEach(() => {
  posted = []
  ;(window as unknown as { webkit: unknown }).webkit = { messageHandlers: { nativeMicrophone: { postMessage: (m: Record<string, unknown>) => posted.push(m) } } }
  useReceptionistStore.setState({ holder: null })
  uninstall = installStayAwake()
})
afterEach(() => uninstall())

const asked = () => posted.filter((m) => m.action === 'stay-awake').map((m) => m.on)

describe('keeping the app awake', () => {
  it('asks while this phone holds Control, and lets go when another device takes it', () => {
    useReceptionistStore.getState().setHolder(phone, PHONE)
    useReceptionistStore.getState().setHolder(mac, PHONE)
    expect(asked()).toEqual([true, false])
  })

  it('says nothing until the holder is known', () => {
    useReceptionistStore.getState().setStatus({ phase: 'ready' })
    expect(asked()).toEqual([])
  })

  it('lets go when nobody holds Control', () => {
    useReceptionistStore.getState().setHolder(phone, PHONE)
    useReceptionistStore.getState().setHolder(null, PHONE)
    expect(asked()).toEqual([true, false])
  })
})
