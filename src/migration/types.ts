export interface ScannedFile { relativePath: string; absolutePath: string }

export interface ManifestFile { path: string; sha256: string; size: number }

/**
 * A profile dependency declared as `link:<path>`. Such a spec points at a local
 * directory on the *source* machine, so it cannot be reproduced from a registry
 * on the target machine and must be reported rather than silently reinstalled.
 */
export interface LinkedDependency { profile: string; name: string; spec: string; target: string }

/**
 * A `link:` dependency whose source directory travels inside the package.
 *
 * A `link:` spec names an absolute directory on the source machine. Copying that
 * directory into the package is the only way to make the profile portable when
 * the package is unpublished (and these usually are): a registry cannot supply
 * it, and `pnpm install` reports success against the missing target anyway.
 */
export interface LinkedSource {
  profile: string
  name: string
  /** Absolute directory to recreate, exactly as the `link:` spec spells it. */
  target: string
  /** Path prefix inside the package holding this source tree. */
  prefix: string
  fileCount: number
  bytes: number
}

export interface MigrationManifest {
  formatVersion: number
  createdAt: string
  files: ManifestFile[]
  meta: {
    profiles: string[]
    apiKeyEnvNames: string[]
    sensitiveCategories: string[]
    /** Absent in packages written before link detection existed. */
    linkedDependencies?: LinkedDependency[]
    /** Absent in packages written before linked sources were carried. */
    linkedSources?: LinkedSource[]
  }
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

/** What happened to one carried `link:` source during an apply. */
export interface MaterializeResult {
  name: string
  target: string
  /** `already-present` means the target had content, so it was left alone. */
  status: 'created' | 'already-present' | 'failed'
}

/** How one `dsh.profile.bundles` entry resolves after an install. */
export interface BundleCheck {
  profile: string
  bundle: string
  /** Directory the bundle resolved to, when it resolved at all. */
  dir?: string
  resolved: boolean
  /** DSH refuses to boot a bundle whose package.json declares no `dsh.bundle.patch`. */
  declaresPatch: boolean
  /**
   * Whether an unresolved bundle is *provably* unusable. False when the dsh
   * installation could not be inspected and the bundle is not a profile
   * dependency, in which case it may be an in-box bundle after all.
   */
  conclusive: boolean
}

export type InstallStatus =
  | 'installed'
  | 'installed-with-broken-bundles'
  | 'install-failed'
  | 'spawn-failed'
  | 'lockfile-missing'
  | 'package-missing'

export interface InstallResult {
  profile: string
  ok: boolean
  status: InstallStatus
  /** Bundles that provably cannot be loaded, so this profile will not boot. */
  brokenBundles: string[]
  /**
   * Bundles that could not be resolved and could not be proven broken either,
   * because they may be supplied by the dsh installation.
   */
  unverifiedBundles: string[]
  /**
   * Packages the profile asks pnpm to build, which `--ignore-scripts` skipped.
   * A skipped build is how `cloudflared` loses its downloaded binary.
   */
  skippedBuilds: string[]
}

