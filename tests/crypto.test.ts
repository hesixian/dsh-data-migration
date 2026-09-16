import { describe, expect, it } from 'vitest'
import { decryptContainer, encryptContainer } from '../src/migration/crypto.js'

describe('crypto container', () => {
  it('round-trips and rejects the wrong password', async () => {
    const encrypted = await encryptContainer(Buffer.from('private data'), 'a long enough password')
    await expect(decryptContainer(encrypted, 'a long enough password')).resolves.toEqual(Buffer.from('private data'))
    await expect(decryptContainer(encrypted, 'wrong password')).rejects.toThrow(/password|authentication/i)
  })
  it('authenticates its header', async () => {
    const encrypted = await encryptContainer(Buffer.from('private data'), 'a long enough password')
    encrypted[12] ^= 1
    await expect(decryptContainer(encrypted, 'a long enough password')).rejects.toThrow()
  })
})
