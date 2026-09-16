import { BLOCKED_ENV_NAME, SAFE_ENV_NAME } from './constants.js'
import type { EnvironmentAdapter } from './types.js'

export const processEnvironment: EnvironmentAdapter = { get: name => process.env[name], set: (name, value) => { process.env[name] = value }, unset: name => { delete process.env[name] } }
export function isAllowedApiKeyEnvName(name: string): boolean { return SAFE_ENV_NAME.test(name) && !BLOCKED_ENV_NAME.test(name) }
export function validateApiKeyEnvValues(values: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(values)) { if (!isAllowedApiKeyEnvName(name) || typeof value !== 'string') throw new Error('Invalid migration environment variable'); result[name] = value }
  return result
}
export async function applyEnvValues(adapter: EnvironmentAdapter, values: Record<string, string>): Promise<void> {
  const safeValues = validateApiKeyEnvValues(values); const previous = new Map<string, { exists: boolean; value?: string }>()
  try { for (const [name, value] of Object.entries(safeValues)) { const oldValue = await adapter.get(name); previous.set(name, { exists: oldValue !== undefined, value: oldValue }); await adapter.set(name, value) } }
  catch (error) { for (const [name, old] of [...previous.entries()].reverse()) { if (old.exists) await adapter.set(name, old.value!); else await adapter.unset(name) } throw error }
}
