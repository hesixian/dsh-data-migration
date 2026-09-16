# DSH 私有加密迁移插件实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 `subagent-driven-development`（推荐）或 `executing-plans` 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现可导出、加密、预检和恢复 DSH 配置与凭据的私有 `.dsh-migrate` bundle，并在导入后自动重装各 profile 依赖。

**架构：** Host 插件提供本地 REST 路由，负责白名单扫描、tar.gz 归档、scrypt/AES-GCM 容器、预检、恢复点/原子写入、用户环境变量和 pnpm 安装。Web client 注册设置页卡片，驱动导出、导入预检、确认应用和进度展示。核心逻辑分拆为纯 TypeScript 模块，以 Node 临时目录构建自动化测试。

**技术栈：** Node.js `node:crypto`、`node:zlib`、`tar-stream`、TypeScript、Vitest、Cordis、`@deepseek-ai/dsh-settings`。

---

## 文件结构

- `package.json`：DSH bundle 元数据、依赖、build/test 脚本。
- `tsconfig.json`：Node/DOM TypeScript 编译约束。
- `cordis.patch.yml`：注册 Host 插件实例 `dsh-migration`。
- `.gitignore`：排除构建、测试、迁移包和临时文件。
- `src/index.ts`：Host 插件入口、HTTP 路由和单任务互斥。
- `src/migration/constants.ts`：容器常量、白名单文件名和路径限制。
- `src/migration/types.ts`：manifest、预检、导出、应用和安装结果类型。
- `src/migration/crypto.ts`：scrypt/AES-256-GCM 容器读写。
- `src/migration/archive.ts`：tar.gz 打包与安全解包。
- `src/migration/scanner.ts`：DSH_HOME 白名单扫描及 API Key 环境变量发现。
- `src/migration/manifest.ts`：SHA-256 manifest 生成/校验。
- `src/migration/exporter.ts`：导出编排。
- `src/migration/snapshot.ts`：恢复点、原子替换和文件回滚。
- `src/migration/env.ts`：Windows 用户级环境变量读取/写入/回滚。
- `src/migration/installer.ts`：profile 的 pnpm 安装。
- `src/migration/importer.ts`：预检、确认应用、恢复编排。
- `src/client/index.ts`：DSH Web client 注册。
- `src/client/MigrationSettingsCard.tsx`：迁移设置 UI。
- `src/client/migration.module.css`：迁移 UI 最小样式。
- `tests/*.test.ts`：模块与端到端临时目录测试。
- `README.md`：本地安装、迁移安全说明、导出/导入操作。

## 任务 1：搭建插件包与测试运行器

**文件：**
- 创建：`package.json`
- 创建：`tsconfig.json`
- 创建：`cordis.patch.yml`
- 创建：`.gitignore`
- 创建：`src/migration/constants.ts`
- 创建：`src/migration/types.ts`
- 创建：`tests/setup.test.ts`

- [ ] **步骤 1：编写失败的包边界测试**

```ts
import { describe, expect, it } from 'vitest'
import { CONTAINER_MAGIC, FORMAT_VERSION } from '../src/migration/constants.js'

describe('migration package constants', () => {
  it('uses a stable eight-byte v1 magic header', () => {
    expect(CONTAINER_MAGIC).toEqual(Buffer.from('DSHMIGR1'))
    expect(FORMAT_VERSION).toBe(1)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test -- --run tests/setup.test.ts`

预期：失败，原因是 package/script/module 尚不存在。

- [ ] **步骤 3：创建最小包与常量实现**

```ts
export const CONTAINER_MAGIC = Buffer.from('DSHMIGR1')
export const FORMAT_VERSION = 1
export const GCM_TAG_BYTES = 16
export const HEADER_LENGTH_BYTES = 4
```

`package.json` 声明 `type: module`、`main: lib/index.js`、`exports`（`.` 和 `./client`）、`dsh.bundle.patch` 与 `dsh.client.platform = "web"`；脚本含 `build`、`test`；依赖 `tar-stream`，开发依赖 `typescript`、`vitest`、`tsdown` 与必要类型。

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm test -- --run tests/setup.test.ts`

预期：PASS。

- [ ] **步骤 5：Git 操作**

按用户要求：不初始化 Git、不 commit、不 push。

## 任务 2：实现并验证加密容器

**文件：**
- 创建：`src/migration/crypto.ts`
- 创建：`tests/crypto.test.ts`

- [ ] **步骤 1：编写失败的密码、篡改和往返测试**

```ts
it('round-trips a payload only with the correct password', async () => {
  const packed = await encryptContainer(Buffer.from('secret payload'), 'correct horse')
  await expect(decryptContainer(packed, 'correct horse')).resolves.toEqual(Buffer.from('secret payload'))
  await expect(decryptContainer(packed, 'wrong password')).rejects.toThrow(/password|authentication/i)
})

it('rejects a tampered header or ciphertext', async () => {
  const packed = await encryptContainer(Buffer.from('payload'), 'password')
  packed[12] ^= 0x01
  await expect(decryptContainer(packed, 'password')).rejects.toThrow()
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test -- --run tests/crypto.test.ts`

预期：失败，`encryptContainer` 未定义。

- [ ] **步骤 3：实现 scrypt 与 AES-GCM**

```ts
export async function encryptContainer(payload: Buffer, password: string): Promise<Buffer> {
  assertPassword(password)
  const salt = randomBytes(16)
  const nonce = randomBytes(12)
  const header = createHeader(salt, nonce)
  const key = await scryptKey(password, salt, header.scrypt)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(headerBytes)
  return Buffer.concat([CONTAINER_MAGIC, uint32(headerBytes.length), headerBytes, cipher.update(payload), cipher.final(), cipher.getAuthTag()])
}
```

实现时必须：固定 scrypt 参数 `N=32768,r=8,p=1`；对 magic、header 长度、JSON 字段、salt/nonce/tag 长度和算法名进行严格校验；所有认证错误统一抛出不含秘密的错误信息。

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm test -- --run tests/crypto.test.ts`

预期：PASS。

- [ ] **步骤 5：Git 操作**

按用户要求：不初始化 Git、不 commit、不 push。

## 任务 3：实现安全归档、扫描与 manifest

**文件：**
- 创建：`src/migration/archive.ts`
- 创建：`src/migration/scanner.ts`
- 创建：`src/migration/manifest.ts`
- 创建：`tests/archive.test.ts`
- 创建：`tests/scanner.test.ts`
- 创建：`tests/manifest.test.ts`

- [ ] **步骤 1：编写失败的白名单/哈希/安全路径测试**

```ts
it('scans only supported DSH files and never node_modules or sessions', async () => {
  const scanned = await scanDshHome(fixtureHome)
  expect(scanned.map(file => file.relativePath)).toContain('settings.yaml')
  expect(scanned.map(file => file.relativePath)).not.toContain('profiles/web/node_modules/x.js')
  expect(scanned.map(file => file.relativePath)).not.toContain('sessions/old.jsonl')
})

it('rejects a tar member that escapes the staging directory', async () => {
  await expect(unpackTarGz(maliciousTar, target)).rejects.toThrow(/unsafe path/i)
})

it('detects a manifest hash mismatch', async () => {
  await expect(validateManifest(staging, alteredManifest)).rejects.toThrow(/hash mismatch/i)
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test -- --run tests/archive.test.ts tests/scanner.test.ts tests/manifest.test.ts`

预期：失败，扫描、归档和 manifest API 尚不存在。

- [ ] **步骤 3：实现白名单扫描、tar.gz 与 manifest**

`scanDshHome(home)` 只枚举规格中的根文件和 `presets/`、`skills/`、`storages/`、每个 profile 的指定配置/data；递归时拒绝符号链接。`discoverApiKeyEnvNames(settingsYaml)` 只返回 `apiKeyEnv:` 标量名集合，不解析/记录值。

`packTarGz(files, extras)` 把 `manifest.json`、`payload/...` 与 `secrets/env.json` 写入 gzip tar。`unpackTarGz` 在写入前使用 `isSafeRelativePath` 拒绝空、绝对、盘符、`..`、NUL 与链接类型条目。

`createManifest` 对每个归档普通文件计算 SHA-256/size；`validateManifest` 验证路径集、size、sha256 并拒绝未列出的 payload 文件。

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm test -- --run tests/archive.test.ts tests/scanner.test.ts tests/manifest.test.ts`

预期：PASS。

- [ ] **步骤 5：Git 操作**

按用户要求：不初始化 Git、不 commit、不 push。

## 任务 4：实现导出编排与导出端到端测试

**文件：**
- 创建：`src/migration/exporter.ts`
- 创建：`tests/exporter.test.ts`

- [ ] **步骤 1：编写失败的导出 E2E 测试**

```ts
it('creates an encrypted migration package without plaintext secrets', async () => {
  const result = await exportMigration({ home: fixtureHome, destination, password: 'passphrase', env: { DEEPSEEK_API_KEY: 'do-not-leak' } })
  const bytes = await readFile(result.outputPath)
  expect(bytes.includes(Buffer.from('do-not-leak'))).toBe(false)
  expect(result.manifest.meta.apiKeyEnvNames).toEqual(['DEEPSEEK_API_KEY'])
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test -- --run tests/exporter.test.ts`

预期：失败，`exportMigration` 不存在。

- [ ] **步骤 3：实现导出编排**

`exportMigration` 必须检查密码非空且至少 12 字符；确保 destination 扩展名是 `.dsh-migrate`；扫描白名单、创建 `secrets/env.json`（只含被 settings 引用且 env 中存在的键）、创建 manifest、打包、加密并原子写 destination。结果只返回路径、size、sha256、manifest 元数据。

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm test -- --run tests/exporter.test.ts`

预期：PASS。

- [ ] **步骤 5：Git 操作**

按用户要求：不初始化 Git、不 commit、不 push。

## 任务 5：实现恢复点、环境变量与 profile 安装器

**文件：**
- 创建：`src/migration/snapshot.ts`
- 创建：`src/migration/env.ts`
- 创建：`src/migration/installer.ts`
- 创建：`tests/snapshot.test.ts`
- 创建：`tests/env.test.ts`
- 创建：`tests/installer.test.ts`

- [ ] **步骤 1：编写失败的回滚、环境变量和 pnpm 参数测试**

```ts
it('restores replaced files when an apply operation fails', async () => {
  await expect(applyAtomically(home, replacements, { failAfter: 1 })).rejects.toThrow()
  expect(await readFile(join(home, 'settings.yaml'), 'utf8')).toBe('old')
})

it('restores prior environment values after a write failure', async () => {
  const env = createMemoryEnv({ DEEPSEEK_API_KEY: 'old' }, { failOnSet: 'SECOND' })
  await expect(applyEnvValues(env, { DEEPSEEK_API_KEY: 'new', SECOND: 'x' })).rejects.toThrow()
  expect(env.get('DEEPSEEK_API_KEY')).toBe('old')
})

it('uses frozen lockfile only when a lockfile exists', async () => {
  expect(commandForProfile('/p/web', true)).toEqual(['pnpm', 'install', '--frozen-lockfile'])
  expect(commandForProfile('/p/desktop', false)).toEqual(['pnpm', 'install'])
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test -- --run tests/snapshot.test.ts tests/env.test.ts tests/installer.test.ts`

预期：失败，目标函数尚不存在。

- [ ] **步骤 3：实现恢复点、用户环境变量与安装器**

`applyAtomically` 将受影响文件复制进 snapshot，临时写入后 rename；错误时从 snapshot 恢复旧文件并删除新增文件。`applyEnvValues` 注入可测试的 user-env adapter；Windows 实现调用 `setx` 或用户 Registry API，不能修改机器级变量，失败回滚前序变量。

`installProfiles` 用 `spawn` 不经 shell 执行 pnpm；有 `pnpm-lock.yaml` 时附 `--frozen-lockfile`；逐 profile 收集去敏 stdout/stderr 截断文本，失败不阻断后续 profile。

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm test -- --run tests/snapshot.test.ts tests/env.test.ts tests/installer.test.ts`

预期：PASS。

- [ ] **步骤 5：Git 操作**

按用户要求：不初始化 Git、不 commit、不 push。

## 任务 6：实现预检/导入编排与端到端验证

**文件：**
- 创建：`src/migration/importer.ts`
- 创建：`tests/importer.test.ts`

- [ ] **步骤 1：编写失败的预检和导入 E2E 测试**

```ts
it('does not modify target home during preflight or wrong-password import', async () => {
  const before = await readFile(join(targetHome, 'settings.yaml'), 'utf8')
  await expect(preflightMigration(packagePath, 'wrong', targetHome)).rejects.toThrow()
  expect(await readFile(join(targetHome, 'settings.yaml'), 'utf8')).toBe(before)
})

it('restores config and environment only after explicit apply', async () => {
  const preview = await preflightMigration(packagePath, password, targetHome)
  expect(preview.meta.profiles).toContain('web')
  await applyMigration(preview, { confirmSensitive: true, installDependencies: false })
  expect(await readFile(join(targetHome, 'settings.yaml'), 'utf8')).toContain('agent-default-model')
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test -- --run tests/importer.test.ts`

预期：失败，预检/应用 API 尚不存在。

- [ ] **步骤 3：实现预检与应用编排**

`preflightMigration` 只解密到 `mkdtemp` staging，运行 manifest 和路径校验，读取 secrets 但结果仅保留环境变量名，生成具备随机 `operationId` 的内存预览；不可从 UI 传任意 staging 路径。

`applyMigration` 接受本进程创建的 operationId、校验用户敏感确认、调用 snapshot/apply/env/installer，finally 清除 staging 和 operationId。依赖安装必须可通过 `installDependencies: false` 关闭以支持测试；生产 UI 默认 true 且要求额外确认。

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm test -- --run tests/importer.test.ts`

预期：PASS。

- [ ] **步骤 5：Git 操作**

按用户要求：不初始化 Git、不 commit、不 push。

## 任务 7：挂载 Cordis Host 路由与 Web 设置页面

**文件：**
- 创建：`src/index.ts`
- 创建：`src/client/index.ts`
- 创建：`src/client/MigrationSettingsCard.tsx`
- 创建：`src/client/migration.module.css`
- 创建：`README.md`
- 修改：`package.json`
- 修改：`cordis.patch.yml`

- [ ] **步骤 1：编写失败的路由输入验证测试**

```ts
it('rejects export requests with a missing output path or password', async () => {
  const response = await request(app, 'POST', '/api/dsh-migration/export', {})
  expect(response.status).toBe(400)
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test -- --run tests/routes.test.ts`

预期：失败，Host 路由尚不存在。

- [ ] **步骤 3：实现受限 Host 路由和客户端页面**

Host 注入 `webServer`，注册：

- `POST /api/dsh-migration/export`
- `POST /api/dsh-migration/preflight`
- `POST /api/dsh-migration/apply`

所有路由只接受 JSON，检查 body 类型、密码、路径；出错返回安全的状态/消息；全插件一个 busy lock。所有文件路径必须限制到本地绝对路径，导入可读、导出父目录必须存在；UI 不持久化密码。

Client 使用 DSH settings 扩展点注册“DSH 迁移”设置卡，提供导出目标、密码与确认，导入文件、密码、预检摘要、两个敏感确认复选框、进度和安全提示。README 写清本地链接安装、需重启 DSH、迁移包高敏感性和无 Git 发布状态。

- [ ] **步骤 4：运行路由测试和生产构建**

运行：`pnpm test -- --run tests/routes.test.ts && pnpm build`

预期：测试 PASS，构建生成 `lib/index.js` 与 `lib/client.js`。

- [ ] **步骤 5：Git 操作**

按用户要求：不初始化 Git、不 commit、不 push。

## 任务 8：完整验证与人工安装检查

**文件：**
- 修改：`README.md`

- [ ] **步骤 1：运行所有测试**

运行：`pnpm test -- --run`

预期：所有测试 PASS。

- [ ] **步骤 2：运行类型检查和构建**

运行：`pnpm exec tsc --noEmit && pnpm build`

预期：退出码 0，产物包含 `lib/index.js` 与 `lib/client.js`。

- [ ] **步骤 3：执行不含 secrets 的手工 smoke 导出/预检**

运行：`pnpm exec tsx scripts/smoke.mts`

预期：输出导出包路径、预检 profile 摘要，并断言导出内容不含测试 secret 明文。

- [ ] **步骤 4：核对发布安全性**

运行：`git status --short`（如非 Git 仓库则记录不执行）和搜索 `DEEPSEEK_API_KEY=` / `OPENCODE_GO_API_KEY=` 等实际 secret 值。

预期：不存在真实凭据、包文件、`node_modules` 或构建临时文件被纳入源码目录。

- [ ] **步骤 5：Git 操作**

按用户要求：不初始化 Git、不 commit、不 push。
