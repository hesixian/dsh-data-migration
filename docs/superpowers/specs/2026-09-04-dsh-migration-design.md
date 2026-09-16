# DSH 私有加密迁移插件设计

- 状态：待用户审查
- 日期：2026-09-04
- 工作目录：`D:\code\dsh-migration`
- Git：暂不初始化、暂不提交、暂不推送

## 1. 目标与边界

本项目实现一个私有 DSH Web bundle，用于在两台可信 Windows 机器之间通过本地文件迁移 DSH 个人配置。插件导出密码保护的 `.dsh-migrate` 文件；新机器导入后恢复配置并自动按 profile 的锁文件重新安装插件。

### 目标

- 本地导出和导入，不依赖 Git、NAS 或云端同步服务。
- 使用 scrypt 派生密钥及 AES-256-GCM 加密，导出包同时提供保密性和篡改检测。
- 默认包含 DSH 设置、profile 配置、skills、presets、storages、插件私有 data、凭据和 settings 中引用的 API Key 环境变量值。
- 导入前完成格式、密码、认证标签、文件哈希和路径安全校验；校验失败时不修改 DSH 数据。
- 导入后仅为具有有效 lockfile 的 profile 重新安装依赖，避免迁移旧机 `node_modules` / pnpm store 链接；默认禁用安装脚本。
- 在导入前为即将覆盖的 DSH 文件建立本地恢复点；写入失败时回滚文件。

### 明确不做

- 不迁移 `node_modules`、pnpm store、运行进程、临时日志。
- 默认不迁移 `sessions`、`attachments`，避免把旧工作区路径、历史聊天及附件无差别带走。
- 不自动创建 GitHub 仓库、提交或推送代码。
- 不在 UI、日志、manifest 预览中展示凭据或 API Key 的值。
- 不绕过 DSH 审批机制；导入应用和 pnpm 安装均要求用户在 UI 明确确认。

## 2. 用户流程

### 2.1 导出

1. 用户打开 DSH Web 的“设置 → DSH 迁移”。
2. 插件扫描固定白名单，展示 profile / skill / preset / 敏感类别的计数，不显示秘密内容。
3. 用户选择输出文件路径，输入并确认密码。
4. Host 读取白名单内容、从已验证的 `settings.yaml` 解析符合安全名称规则的 `apiKeyEnv` 名称，并只读取这些当前用户环境变量；拒绝 `NODE_OPTIONS`、`PATH`、`PNPM_*`、`NPM_CONFIG_*`、代理和证书等运行时变量。
5. Host 创建内部清单、逐文件计算 SHA-256，组装受文件数、单文件大小和总解压大小限制的 tar.gz 有效载荷。
6. Host 使用 scrypt + AES-256-GCM 生成 `.dsh-migrate` 文件，返回路径、大小、SHA-256、已导出项目统计。

### 2.2 导入

1. 用户在新机器的迁移面板选择 `.dsh-migrate` 文件并输入密码。
2. Host 只解密到受限私有临时目录，校验容器头、版本、AES-GCM 标签、manifest、文件哈希、严格白名单路径、文件数和解压容量。
3. UI 显示预检摘要：包版本、导出时间、profile、插件依赖数、是否包含凭据/API Key；不显示值。Host 为该包哈希生成短时、单次使用的服务端 operation id。
4. 用户显式勾选“我知道包包含敏感凭据”和“允许自动安装插件”，然后以 operation id 开始应用；Host 校验确认绑定的包哈希和有效期。
5. Host 对目标 DSH 文件建立受保护恢复点，使用原子替换写入迁移文件。
6. Host 将 `secrets/env.json` 中仅允许的 API Key 名称写入当前 Windows 用户环境变量；当前进程同步设置这些值供未来子进程使用，但安装器不继承这些秘密值。
7. Host 仅对有效 `pnpm-lock.yaml` 的恢复 profile 执行受限的 `pnpm install --frozen-lockfile --ignore-scripts`；无 lockfile 或不可信 `.npmrc` 的 profile 标记为手工处理。
8. UI 汇总写入、回滚和各 profile 安装结果，提示用户重启 `dsh web`。

## 3. 容器格式与安全模型

### 3.1 文件格式

扩展名：`.dsh-migrate`。

二进制容器：

```text
magic: "DSHMIGR1" (8 bytes)
headerLength: uint32 big-endian
headerJson: UTF-8 JSON
ciphertext: bytes
authTag: 16 bytes
```

`headerJson`：

```json
{
  "formatVersion": 1,
  "cipher": "aes-256-gcm",
  "kdf": "scrypt",
  "salt": "base64",
  "nonce": "base64",
  "scrypt": { "N": 32768, "r": 8, "p": 1 },
  "payload": "tar.gz",
  "createdAt": "ISO-8601"
}
```

- 密钥不写入文件，也不保存到 DSH 设置或日志。
- header 是 AES-GCM 的 AAD，攻击者替换 KDF / nonce / 版本字段会导致认证失败。
- 导出结束后计算整个包的 SHA-256，仅用于用户在传输前后人工比对；保密性和真实性由 GCM 保证。

### 3.2 内部结构

```text
manifest.json
payload/settings.yaml
payload/cordis.patch.yml
payload/.credentials.yaml
payload/presets/**
payload/skills/**
payload/storages/**
payload/profiles/<profile>/{package.json,pnpm-lock.yaml,pnpm-workspace.yaml,cordis.yml,cordis.patch.yml,.npmrc}
payload/profiles/<profile>/data/**
secrets/env.json
```

`manifest.json` 记录格式版本、生成时间、profile/skill/preset 计数、敏感类别、密钥变量名、逐文件 SHA-256 和字节数。绝不记录 API Key 或凭据值。

## 4. 导出白名单与敏感内容

### 4.1 默认包含

- `$DSH_HOME/settings.yaml`
- `$DSH_HOME/cordis.patch.yml`
- `$DSH_HOME/.credentials.yaml`（若存在）
- `$DSH_HOME/presets/**`
- `$DSH_HOME/skills/**`
- `$DSH_HOME/storages/**`
- `$DSH_HOME/profiles/<name>/package.json`
- `$DSH_HOME/profiles/<name>/pnpm-lock.yaml`
- `$DSH_HOME/profiles/<name>/pnpm-workspace.yaml`
- `$DSH_HOME/profiles/<name>/cordis.yml`
- `$DSH_HOME/profiles/<name>/cordis.patch.yml`
- `$DSH_HOME/profiles/<name>/.npmrc`（仅在通过安全策略校验后保留；含 registry 覆盖、认证/token、`script-shell`、`userconfig`、`globalconfig`、证书或代理设置时不自动用于安装）
- `$DSH_HOME/profiles/<name>/data/**`
- `settings.yaml` 中 `apiKeyEnv` 指向、匹配 `^[A-Z][A-Z0-9_]{0,127}$` 且不属于运行时/包管理器拒绝名单的当前用户环境变量值。

### 4.2 默认排除

- `$DSH_HOME/profiles/**/node_modules/**`
- pnpm store
- `$DSH_HOME/sessions/**`
- `$DSH_HOME/attachments/**`
- `$DSH_HOME/.claude/**`
- 未在白名单中的 profile 文件
- 符号链接、硬链接、设备文件、PAX 路径覆盖、Windows reparse point 和路径逃逸文件
- `$DSH_HOME/migration-snapshots/**`

### 4.3 安全说明

此包包含 `.credentials.yaml` 和 API Key，等同于 DSH 身份备份。导出和导入页面必须显示明显警告；仅应存放在可信离线介质或用户自己控制的加密存储中。

## 5. 插件架构

```text
dsh-migration/
├─ docs/superpowers/specs/
├─ src/
│  ├─ index.ts              # Cordis Host 插件入口、路由与设置注册
│  ├─ schema.ts             # 请求/响应与配置 schema
│  ├─ migration/
│  │  ├─ constants.ts       # 容器与白名单常量
│  │  ├─ scanner.ts         # 白名单扫描、API Key env 名发现
│  │  ├─ manifest.ts        # manifest 创建与校验
│  │  ├─ archive.ts         # tar.gz 创建与安全解包
│  │  ├─ crypto.ts          # scrypt / AES-GCM 容器
│  │  ├─ exporter.ts        # 导出编排
│  │  ├─ importer.ts        # 预检和导入编排
│  │  ├─ snapshot.ts        # 恢复点、原子替换、回滚
│  │  ├─ env.ts             # Windows 用户环境变量读写
│  │  └─ installer.ts       # pnpm profile 依赖安装
│  └─ client/
│     ├─ index.tsx          # 客户端注册
│     ├─ MigrationSettingsCard.tsx
│     └─ migration.module.css
├─ tests/
│  ├─ crypto.test.ts
│  ├─ archive.test.ts
│  ├─ scanner.test.ts
│  ├─ manifest.test.ts
│  ├─ importer.test.ts
│  └─ snapshot.test.ts
├─ package.json
├─ tsconfig.json
├─ cordis.patch.yml
├─ README.md
└─ .gitignore
```

- Host 只经 `/api/dsh-migration/*` 路由处理文件系统、加解密、环境变量、pnpm 调用；路由必须采用 DSH 同源/会话防护，拒绝跨源 Origin 与 `Sec-Fetch-Site: cross-site` 请求，不发送宽松 CORS。
- Client 只处理选择文件、密码输入、预检摘要、确认和进度；不会持久化密码或秘密值。
- 所有变更请求有严格 JSON schema、请求体上限、服务端短期 operation id 和单次使用确认；客户端不能指定临时目录、目标根目录、profile 名或子进程参数。
- 操作排他：同一时刻只允许一个导出或导入任务，避免恢复与导出相互覆盖。

## 6. 导入一致性、恢复点与错误处理

### 6.1 预检

导入应用前必须依次完成：

1. 容器 magic / 版本校验；
2. 密码解密和 AES-GCM 认证；
3. 解压到迁移插件专属临时目录；
4. manifest 存在、版本兼容；归档的每一个文件均恰好出现一次在 manifest 中，且只允许固定 `manifest.json`、`payload/...` 与 `secrets/env.json` 结构；
5. 路径无绝对路径/`..`/NUL/链接/Windows 保留名/尾部空格或句点，拒绝重复项、大小写碰撞和规范化碰撞；
6. 清单内每个文件 SHA-256 与长度一致，且文件数、单文件大小、总解压大小、目录深度均未超限；
7. package.json 可解析且 profile 名安全；
8. 仅展示摘要，等待用户确认。

预检失败时删除临时目录，且不写 `$DSH_HOME`。

### 6.2 应用和回滚

- 导入前拒绝与另一个迁移操作并发；建立包含受管理文件清单和事务状态的恢复点，`migration-snapshots` 使用用户私有目录并默认不参与后续导出。
- 每个目标文件写到同目录临时文件后，重新验证解析路径仍在 `$DSH_HOME` 根内，再使用 rename 原子替换。
- 文件写入阶段任一失败：删除已写入新文件、从 snapshot 恢复原文件；返回不含秘密的失败详情。进程异常后的恢复由遗留事务状态提示用户在下次启动时手动恢复。
- 环境变量写入失败：同样恢复已成功写入变量的“缺失/空字符串/值”原状态，并触发文件回滚。
- pnpm 安装发生在配置写入后；单个 profile 安装失败不回滚已恢复配置，UI 将其标识为 `failed` 并给出不含原始子进程输出的可重试摘要。

### 6.3 Windows 环境变量

- 使用用户范围的 Windows 环境变量存储 API Key；不写机器范围，不要求管理员权限。
- 先记录旧值（区分不存在和空字符串），再写新值；写入时更新当前 Node `process.env`，但只有未来子进程继承，现存进程仍需重启。
- 安装器使用最小、受控的环境，不继承恢复的 API Key、`NODE_OPTIONS`、`PATH`、pnpm/npm 配置、代理和证书变量。
- 提示用户重启 DSH/新开终端以保证所有子进程读取到持久化的新环境。

## 7. 插件依赖恢复

对成功恢复的每个 profile：

- 检查 `package.json` 是否存在；
- 仅有通过版本/完整性检查的 `pnpm-lock.yaml`：执行可信 pnpm 的 `install --frozen-lockfile --ignore-scripts`；
- 无 lockfile：绝不自动安装，明确标为 `manual-required`；
- pnpm 不在受信任绝对路径或 PATH：明确报告并提示安装；
- profile `.npmrc` 只有未包含 registry 覆盖、scope registry、认证/token、`script-shell`、`userconfig`、`globalconfig`、`cafile`、代理设置等危险项时才能参与自动安装；否则标为手工处理；
- 绝不复制旧机 node_modules 或 pnpm store；
- 不向 UI 返回原始 stdout/stderr；只返回 allowlist 的状态、退出码和固定长度安全摘要。运行第三方 lifecycle scripts 需作为未来单独的、二次确认功能，默认不支持。

## 8. 测试与验收

### 单元测试

- 同密码加密/解密往返；错误密码和篡改 header/ciphertext/tag 均失败；header/ciphertext 与 scrypt 参数受固定上限。
- 白名单只导出允许路径，拒绝符号链接、硬链接、reparse point、PAX 覆盖、保留名、大小写碰撞、路径逃逸与归档炸弹。
- manifest 采用严格精确集合规则，拒绝额外、重复或未列出的文件，并校验文件哈希、大小、路径。
- 预检失败、跨源请求或 operation id 重放均不写入目标目录。
- 写入失败触发 snapshot 回滚；环境变量恢复保留缺失/空字符串语义。
- pnpm 只对 lockfile profile 使用 `--frozen-lockfile --ignore-scripts`；恶意 `.npmrc`、运行时 env 污染和原始安装输出均不会进入自动安装或 UI。

### 手工集成验收

1. 在当前机器创建一个含 settings / skill / web profile 的测试 DSH_HOME。
2. 导出 `.dsh-migrate`；验证文件不含明文 API Key（使用 bytes 搜索）。
3. 导入到隔离测试 DSH_HOME；检查配置、skills、profiles 和环境变量恢复。
4. 错误密码、篡改文件、写入失败均验证不污染目标。
5. 对真实新机执行导入后，确认 pnpm 安装结果并重启 `dsh web`。

## 9. 发布与安装方式

本阶段仅完成本地项目，不建立 GitHub 仓库，不提交、不推送。

插件完成后可通过本地路径安装：

```powershell
dsh plugin --profile web add link:D:\code\dsh-migration
```

未来用户创建私有仓库 `hesixian/dsh-migration` 后，再由用户明确授权执行初始化、提交和推送；发布前应复查 README 不含真实路径、密钥或个人会话信息。
