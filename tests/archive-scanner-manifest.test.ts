import { link, mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { packTarGz, unpackTarGz } from '../src/migration/archive.js'
import { createManifest, validateManifest } from '../src/migration/manifest.js'
import { discoverApiKeyEnvNames, scanDshHome } from '../src/migration/scanner.js'

describe('archive, scanner, and manifest', () => {
  it('scans the DSH whitelist and excludes unsupported content', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-home-')); await mkdir(join(home, 'profiles', 'web', 'data'), { recursive: true }); await mkdir(join(home, 'profiles', 'web', 'node_modules'), { recursive: true }); await mkdir(join(home, 'sessions'), { recursive: true })
    await writeFile(join(home, 'settings.yaml'), 'apiKeyEnv: API_KEY\n'); await writeFile(join(home, 'profiles', 'web', 'package.json'), '{}'); await writeFile(join(home, 'profiles', 'web', 'data', 'state.json'), '{}'); await writeFile(join(home, 'profiles', 'web', 'node_modules', 'skip.js'), 'skip'); await writeFile(join(home, 'sessions', 'skip.json'), 'skip')
    const files = await scanDshHome(home); expect(files.map(file => file.relativePath)).toEqual(expect.arrayContaining(['settings.yaml', 'profiles/web/package.json', 'profiles/web/data/state.json'])); expect(files.map(file => file.relativePath)).not.toContain('profiles/web/node_modules/skip.js'); expect(discoverApiKeyEnvNames(' apiKeyEnv: FIRST\napiKeyEnv: "SECOND"')).toEqual(['FIRST', 'SECOND'])
  })
  it('excludes hard-linked regular files', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hardlink-home-')); await mkdir(join(home, 'skills'), { recursive: true }); await writeFile(join(home, 'skills', 'original.txt'), 'secret'); await link(join(home, 'skills', 'original.txt'), join(home, 'skills', 'linked.txt'))
    expect((await scanDshHome(home)).map(file => file.relativePath)).not.toContain('skills/linked.txt'); expect((await scanDshHome(home)).map(file => file.relativePath)).not.toContain('skills/original.txt')
  })
  it('rejects traversal archive members before they can be created', async () => { await expect(packTarGz([{ path: '../escape', data: Buffer.from('bad') }])).rejects.toThrow(/unsafe/i) })
  it('rejects invalid or payload-mismatched manifest profile metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'manifest-profiles-')); const payload = { path: 'payload/profiles/web/package.json', data: Buffer.from('{}') }; const secret = { path: 'secrets/env.json', data: Buffer.from('{}') }
    for (const profiles of [['../escape'], ['desktop']]) { const manifest = createManifest([payload, secret], { profiles, apiKeyEnvNames: [], sensitiveCategories: [] }); await mkdir(join(root, 'payload', 'profiles', 'web'), { recursive: true }); await mkdir(join(root, 'secrets'), { recursive: true }); await writeFile(join(root, payload.path), payload.data); await writeFile(join(root, secret.path), secret.data); await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest)); await expect(validateManifest(root, manifest)).rejects.toThrow(/profile/i) }
  })
  it('rejects extra unmanifested archive files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'manifest-extra-')); const entry = { path: 'payload/settings.yaml', data: Buffer.from('good') }; const manifest = createManifest([entry]); await mkdir(join(root, 'payload')); await writeFile(join(root, entry.path), entry.data); await writeFile(join(root, 'payload', 'extra.yaml'), 'extra'); await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest)); await expect(validateManifest(root, manifest)).rejects.toThrow(/unmanifested/i)
  })
  it('validates file hashes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'manifest-')); const entry = { path: 'payload/settings.yaml', data: Buffer.from('good') }; const manifest = createManifest([entry]); await mkdir(join(root, 'payload')); await writeFile(join(root, entry.path), entry.data); await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest)); await validateManifest(root, manifest); await writeFile(join(root, entry.path), 'evil'); await expect(validateManifest(root, manifest)).rejects.toThrow(/hash mismatch/i)
  })
})
