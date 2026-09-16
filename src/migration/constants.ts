export const CONTAINER_MAGIC = Buffer.from('DSHMIGR1', 'ascii')
export const FORMAT_VERSION = 1
export const HEADER_LENGTH_BYTES = 4
export const GCM_TAG_BYTES = 16
export const SCRYPT_PARAMETERS = { N: 32_768, r: 8, p: 1 } as const
export const MAX_HEADER_BYTES = 16 * 1024

/**
 * Home-root paths that carry user state.
 *
 * The state directories below belong to plugins that get reinstalled from the
 * registry (skin-center, task-board, remote-web-ui, the pet, usage ledgers), so
 * without them a migrated machine loses that state even though the plugins
 * themselves load fine. All of them are small.
 *
 * `.anonymous-user-id` is deliberately absent: it is an anonymous telemetry
 * identity, and cloning it would make two machines report as one.
 */
export const ROOT_FILES = [
  'settings.yaml',
  'cordis.patch.yml',
  '.credentials.yaml',
  'pet.json',
  'skin-center-active.json',
] as const
export const ROOT_DIRECTORIES = [
  'presets',
  'skills',
  'storages',
  'skin-center',
  'task-board',
  'remote-web-ui-registry',
  'dsh-usage',
  'dsh-session-archive',
  'data',
] as const
export const PROFILE_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml', 'cordis.patch.yml', '.npmrc'] as const
export const EXCLUDED_DIRECTORY_NAMES = new Set(['node_modules', 'sessions', 'attachments', '.claude', 'migration-snapshots'])
/**
 * Lock and temp files must not travel: a migrated `task-board/ledger-v2.lock` or
 * a `<name>.<pid>.<ts>.tmp` would arrive stale and can wedge the plugin that
 * owns it on the new machine.
 */
export const EXCLUDED_FILE_PATTERN = /\.(?:lock|tmp)$/i

export const SAFE_ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/
export const BLOCKED_ENV_NAME = /^(?:NODE_OPTIONS|PATH|PNPM(?:_|$)|NPM_CONFIG(?:_|$)|npm_config(?:_|$)|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT(?:_DIR|_FILE)?|NODE_EXTRA_CA_CERTS|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE)$/i
export const MAX_ARCHIVE_ENTRIES = 10_000
export const MAX_ARCHIVE_ENTRY_BYTES = 32 * 1024 * 1024
export const MAX_ARCHIVE_TOTAL_BYTES = 256 * 1024 * 1024
