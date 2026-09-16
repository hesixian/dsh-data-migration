import { createGzip, gunzipSync } from 'node:zlib'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import tar from 'tar-stream'
import { MAX_ARCHIVE_ENTRIES, MAX_ARCHIVE_ENTRY_BYTES, MAX_ARCHIVE_TOTAL_BYTES } from './constants.js'

export interface ArchiveEntry { path: string; data: Buffer }
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i

export function isSafeRelativePath(value: string): boolean {
  const parts = value.split('/')
  return Boolean(value) && value === value.replaceAll('\\', '/') && !value.includes('\0') && !isAbsolute(value) && !/^[A-Za-z]:/.test(value) && parts.every(part => part && part !== '.' && part !== '..' && !WINDOWS_RESERVED.test(part) && !/[. ]$/.test(part))
}
export function isAllowedArchivePath(path: string): boolean {
  return path === 'manifest.json' || path === 'secrets/env.json' || path.startsWith('payload/') && isSafeRelativePath(path.slice('payload/'.length))
}
function keyForCase(path: string): string { return path.toLocaleLowerCase('en-US') }

export async function packTarGz(entries: ArchiveEntry[]): Promise<Buffer> {
  if (entries.length > MAX_ARCHIVE_ENTRIES) throw new Error('Archive entry limit exceeded')
  const seen = new Set<string>(); let total = 0
  for (const entry of entries) { if (!isSafeRelativePath(entry.path) || !isAllowedArchivePath(entry.path)) throw new Error(`Unsafe archive path: ${entry.path}`); if (entry.data.length > MAX_ARCHIVE_ENTRY_BYTES || (total += entry.data.length) > MAX_ARCHIVE_TOTAL_BYTES) throw new Error('Archive size limit exceeded'); const key = keyForCase(entry.path); if (seen.has(key)) throw new Error('Duplicate archive path'); seen.add(key) }
  const pack = tar.pack(); const chunks: Buffer[] = []; const gzip = createGzip()
  const result = new Promise<Buffer>((resolveResult, reject) => { gzip.on('data', chunk => chunks.push(Buffer.from(chunk))); gzip.on('end', () => resolveResult(Buffer.concat(chunks))); gzip.on('error', reject) })
  pack.pipe(gzip)
  for (const entry of entries) await new Promise<void>((resolveEntry, reject) => pack.entry({ name: entry.path, type: 'file', mode: 0o600, size: entry.data.length }, entry.data, error => error ? reject(error) : resolveEntry()))
  pack.finalize(); return result
}

export async function unpackTarGz(input: Buffer, destination: string): Promise<string[]> {
  let raw: Buffer; try { raw = gunzipSync(input, { maxOutputLength: MAX_ARCHIVE_TOTAL_BYTES }) } catch { throw new Error('Invalid or oversized gzip archive') }
  const extract = tar.extract(); const paths: string[] = []; const seen = new Set<string>(); const root = resolve(destination); let total = 0
  const done = new Promise<void>((resolveDone, reject) => { extract.on('finish', resolveDone); extract.on('error', reject) })
  extract.on('entry', (header, stream, next) => {
    const fail = (message: string) => { stream.resume(); extract.destroy(new Error(message)) }
    if (paths.length >= MAX_ARCHIVE_ENTRIES || header.type !== 'file' || !isSafeRelativePath(header.name) || !isAllowedArchivePath(header.name) || header.size > MAX_ARCHIVE_ENTRY_BYTES) return fail('Unsafe archive entry')
    const caseKey = keyForCase(header.name); if (seen.has(caseKey)) return fail('Duplicate archive path'); seen.add(caseKey)
    const target = resolve(root, header.name); if (relative(root, target).startsWith(`..${sep}`) || relative(root, target) === '..') return fail('Unsafe archive path')
    const chunks: Buffer[] = []; let entrySize = 0
    stream.on('data', (chunk: unknown) => { const bytes = Buffer.from(chunk as Uint8Array); entrySize += bytes.length; total += bytes.length; if (entrySize > MAX_ARCHIVE_ENTRY_BYTES || total > MAX_ARCHIVE_TOTAL_BYTES) extract.destroy(new Error('Archive size limit exceeded')); else chunks.push(bytes) })
    stream.on('error', error => extract.destroy(error))
    stream.on('end', async () => { try { if (entrySize !== header.size) throw new Error('Invalid archive entry size'); await mkdir(dirname(target), { recursive: true }); await writeFile(target, Buffer.concat(chunks), { mode: 0o600, flag: 'wx' }); paths.push(header.name); next() } catch (error) { extract.destroy(error as Error) } })
  })
  extract.end(raw); await done; return paths
}

export async function listArchiveFiles(root: string, current = root): Promise<string[]> {
  const paths: string[] = []
  for (const entry of await readdir(current, { withFileTypes: true })) { const full = resolve(current, entry.name); if (entry.isDirectory()) paths.push(...await listArchiveFiles(root, full)); else if (entry.isFile()) paths.push(relative(root, full).replaceAll('\\', '/')); else throw new Error('Unsafe extracted archive entry') }
  return paths
}
export async function entriesFromFiles(files: { relativePath: string; absolutePath: string }[], prefix = 'payload'): Promise<ArchiveEntry[]> { return Promise.all(files.map(async file => ({ path: `${prefix}/${file.relativePath.replaceAll('\\', '/')}`, data: await readFile(file.absolutePath) }))) }
