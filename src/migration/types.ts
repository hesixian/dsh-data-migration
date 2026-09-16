export interface ScannedFile { relativePath: string; absolutePath: string }

export interface ManifestFile { path: string; sha256: string; size: number }
export interface MigrationManifest {
  formatVersion: number
  createdAt: string
  files: ManifestFile[]
  meta: { profiles: string[]; apiKeyEnvNames: string[]; sensitiveCategories: string[] }
}

export interface ExportResult {
  outputPath: string
  size: number
  sha256: string
  manifest: MigrationManifest
}

export interface EnvironmentAdapter {
  get(name: string): Promise<string | undefined> | string | undefined
  set(name: string, value: string): Promise<void> | void
  unset(name: string): Promise<void> | void
}

export interface PreflightResult {
  operationId: string
  targetHome: string
  manifest: MigrationManifest
  hasSensitiveData: boolean
}

export interface InstallResult { profile: string; ok: boolean; status: 'installed' | 'install-failed' | 'spawn-failed' | 'lockfile-missing' | 'package-missing' }
