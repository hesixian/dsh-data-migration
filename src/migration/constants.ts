export const CONTAINER_MAGIC = Buffer.from('DSHMIGR1', 'ascii')
export const FORMAT_VERSION = 1
export const HEADER_LENGTH_BYTES = 4
export const GCM_TAG_BYTES = 16
export const SCRYPT_PARAMETERS = { N: 32_768, r: 8, p: 1 } as const
export const MAX_HEADER_BYTES = 16 * 1024

export const ROOT_FILES = ['settings.yaml', 'cordis.patch.yml', '.credentials.yaml'] as const
export const ROOT_DIRECTORIES = ['presets', 'skills', 'storages'] as const
export const PROFILE_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml', 'cordis.patch.yml', '.npmrc'] as const
export const EXCLUDED_DIRECTORY_NAMES = new Set(['node_modules', 'sessions', 'attachments', '.claude', 'migration-snapshots'])

export const SAFE_ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/
export const BLOCKED_ENV_NAME = /^(?:NODE_OPTIONS|PATH|PNPM(?:_|$)|NPM_CONFIG(?:_|$)|npm_config(?:_|$)|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT(?:_DIR|_FILE)?|NODE_EXTRA_CA_CERTS|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE)$/i
export const MAX_ARCHIVE_ENTRIES = 10_000
export const MAX_ARCHIVE_ENTRY_BYTES = 32 * 1024 * 1024
export const MAX_ARCHIVE_TOTAL_BYTES = 256 * 1024 * 1024
