import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from 'node:crypto'
import { CONTAINER_MAGIC, FORMAT_VERSION, GCM_TAG_BYTES, HEADER_LENGTH_BYTES, MAX_HEADER_BYTES, SCRYPT_PARAMETERS } from './constants.js'

const scrypt = (password: string, salt: Buffer): Promise<Buffer> => new Promise((resolve, reject) => {
  scryptCallback(password, salt, 32, { N: SCRYPT_PARAMETERS.N, r: SCRYPT_PARAMETERS.r, p: SCRYPT_PARAMETERS.p, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key))
})
interface Header { formatVersion: number; cipher: string; kdf: string; salt: string; nonce: string; scrypt: typeof SCRYPT_PARAMETERS; payload: string; createdAt: string }

function assertPassword(password: string): void { if (!password) throw new Error('A password is required') }
function encodeLength(length: number): Buffer { const result = Buffer.alloc(HEADER_LENGTH_BYTES); result.writeUInt32BE(length); return result }
function headerFor(salt: Buffer, nonce: Buffer): Header {
  return { formatVersion: FORMAT_VERSION, cipher: 'aes-256-gcm', kdf: 'scrypt', salt: salt.toString('base64'), nonce: nonce.toString('base64'), scrypt: SCRYPT_PARAMETERS, payload: 'tar.gz', createdAt: new Date().toISOString() }
}
async function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return await scrypt(password, salt)
}
function parseHeader(bytes: Buffer): Header {
  let header: unknown
  try { header = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('Invalid migration header') }
  const value = header as Partial<Header>
  if (value.formatVersion !== FORMAT_VERSION || value.cipher !== 'aes-256-gcm' || value.kdf !== 'scrypt' || value.payload !== 'tar.gz' || value.scrypt?.N !== SCRYPT_PARAMETERS.N || value.scrypt?.r !== SCRYPT_PARAMETERS.r || value.scrypt?.p !== SCRYPT_PARAMETERS.p || typeof value.salt !== 'string' || typeof value.nonce !== 'string') throw new Error('Unsupported migration header')
  const salt = Buffer.from(value.salt, 'base64'); const nonce = Buffer.from(value.nonce, 'base64')
  if (salt.length !== 16 || nonce.length !== 12) throw new Error('Invalid migration header')
  return value as Header
}

export async function encryptContainer(payload: Buffer, password: string): Promise<Buffer> {
  assertPassword(password)
  const salt = randomBytes(16); const nonce = randomBytes(12)
  const headerBytes = Buffer.from(JSON.stringify(headerFor(salt, nonce)), 'utf8')
  const cipher = createCipheriv('aes-256-gcm', await deriveKey(password, salt), nonce)
  cipher.setAAD(headerBytes)
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()])
  return Buffer.concat([CONTAINER_MAGIC, encodeLength(headerBytes.length), headerBytes, ciphertext, cipher.getAuthTag()])
}

export async function decryptContainer(container: Buffer, password: string): Promise<Buffer> {
  assertPassword(password)
  if (container.length < CONTAINER_MAGIC.length + HEADER_LENGTH_BYTES + GCM_TAG_BYTES || !container.subarray(0, 8).equals(CONTAINER_MAGIC)) throw new Error('Invalid migration container')
  const headerLength = container.readUInt32BE(CONTAINER_MAGIC.length)
  const headerStart = CONTAINER_MAGIC.length + HEADER_LENGTH_BYTES; const headerEnd = headerStart + headerLength
  if (headerLength === 0 || headerLength > MAX_HEADER_BYTES || headerEnd + GCM_TAG_BYTES > container.length) throw new Error('Invalid migration container')
  const headerBytes = container.subarray(headerStart, headerEnd); const header = parseHeader(headerBytes)
  try {
    const decipher = createDecipheriv('aes-256-gcm', await deriveKey(password, Buffer.from(header.salt, 'base64')), Buffer.from(header.nonce, 'base64'))
    decipher.setAAD(headerBytes); decipher.setAuthTag(container.subarray(container.length - GCM_TAG_BYTES))
    return Buffer.concat([decipher.update(container.subarray(headerEnd, -GCM_TAG_BYTES)), decipher.final()])
  } catch { throw new Error('Invalid password or failed migration authentication') }
}
