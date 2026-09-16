import { copyFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

interface SnapshotEntry { target: string; backup?: string }
export interface Replacement { relativePath: string; data: Buffer }
export interface ApplyHandle { rollback(): Promise<void> }

function targetFor(root: string, relativePath: string): string {
  if (!relativePath || relativePath.split(/[\\/]/).includes('..')) throw new Error('Unsafe replacement path')
  const target = resolve(root, relativePath); if (relative(root, target).startsWith('..')) throw new Error('Unsafe replacement path'); return target
}
async function rollbackEntries(entries: SnapshotEntry[]): Promise<void> {
  for (const entry of [...entries].reverse()) { if (entry.backup) { await mkdir(dirname(entry.target), { recursive: true }); await copyFile(entry.backup, entry.target) } else await rm(entry.target, { force: true }) }
}
export async function applyAtomically(home: string, replacements: Replacement[], options: { failAfter?: number } = {}): Promise<ApplyHandle> {
  const snapshotRoot = join(home, 'migration-snapshots', new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID())
  const snapshots: SnapshotEntry[] = []; const written: string[] = []; let rolledBack = false
  const rollback = async (): Promise<void> => { if (!rolledBack) { rolledBack = true; await rollbackEntries(snapshots) } }
  try {
    for (const replacement of replacements) {
      const target = targetFor(home, replacement.relativePath); let backup: string | undefined
      try { await stat(target); backup = join(snapshotRoot, replacement.relativePath); await mkdir(dirname(backup), { recursive: true }); await copyFile(target, backup) } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      snapshots.push({ target, backup }); await mkdir(dirname(target), { recursive: true })
      const temp = `${target}.${randomUUID()}.tmp`; await writeFile(temp, replacement.data, { mode: 0o600 }); await rename(temp, target); written.push(target)
      if (options.failAfter !== undefined && written.length >= options.failAfter) throw new Error('Injected write failure')
    }
    return { rollback }
  } catch (error) { await rollback(); throw error }
}
