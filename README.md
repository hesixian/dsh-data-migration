# DSH Data Migration

DSH Web 的本地数据迁移插件。它把 DSH 的配置、profile 插件清单、skills、presets、storages、插件私有数据、`.credentials.yaml`，以及 `settings.yaml` 引用的 API Key 环境变量，打进一个密码保护的 `.dsh-migrate` 文件；在新机器上先预检、再确认恢复。

> **高敏感操作**：迁移包等同于 DSH 身份备份。只应保存在可信的离线介质，或你自己控制的加密存储中；不要通过聊天软件、公共网盘或邮件转发。

## 功能

- **导出**：用系统文件夹对话框选择保存位置，自动生成 `backup.dsh-migrate`；也可以直接填写完整的 `.dsh-migrate` 文件路径。
- **导入**：既可以用文件对话框直接选择 `.dsh-migrate`，也可以选择它所在的文件夹（自动读取其中的 `backup.dsh-migrate`）。
- **预检**：解密、校验清单与哈希后才展示摘要（导出时间、profile、文件数、API Key 变量名、敏感类别）；预检阶段不修改本机任何配置。
- **确认恢复**：必须勾选敏感数据声明才会启用恢复按钮；恢复前为目标文件建立恢复点，写入或环境变量失败时自动回滚。
- **依赖恢复**：仅对带有 `pnpm-lock.yaml` 的 profile 自动执行 `pnpm install --frozen-lockfile --ignore-scripts`，且不继承恢复出来的 API Key。

## 安全模型

- scrypt（`N=32768, r=8, p=1`）派生密钥，内容使用 AES-256-GCM 加密并认证；header 作为 AAD，篡改 KDF/nonce/版本字段会导致认证失败。
- 包内不迁移 `node_modules`、pnpm store、会话、附件或运行日志。
- 仅迁移 `settings.yaml` 中声明的安全 `apiKeyEnv` 环境变量；拒绝 `PATH`、`NODE_OPTIONS`、pnpm/npm 配置、代理及证书变量。
- 导入先预检：认证、严格文件白名单、哈希、路径、重复/大小写冲突、链接及解压容量限制全部通过后才允许应用。
- 所有接口仅限本机回环地址与同源请求（非回环、跨站 `Sec-Fetch-Site` 一律 403），写操作只接受 POST。
- 页面不显示凭据或 API Key 的值，也从不显示原始安装日志。

## 安装

```powershell
cd D:\code\dsh-data-migration
pnpm install
pnpm build

# 把本地 bundle 加入 DSH Web profile
dsh plugin --profile web add link:D:\code\dsh-data-migration
```

然后重启 `dsh web`，打开 **设置 → DSH 数据迁移**。

> 插件的主机半（路由）在 `dsh web` 启动时装载，浏览器半在页面加载时装载。
> **改动源码后必须重新 `pnpm build` 并重启 `dsh web`**，否则页面会调用到尚未注册的路由。

## 使用

1. 旧机：选择保存文件夹（或填写完整 `.dsh-migrate` 路径），设置至少 12 位密码，点“导出”。
2. 把迁移包传到新机，并在新机安装本插件。
3. 新机：选择迁移包（文件或所在文件夹）并输入密码，点“预检”。这一步不会修改本机配置。
4. 阅读预检摘要，勾选敏感凭据确认，按需保留“自动安装 profile 依赖”。
5. 点“确认并恢复”，完成后重启 `dsh web` 或新开终端，让新的环境变量生效。

## 开发验证

```powershell
pnpm typecheck
pnpm test
pnpm build
```

测试覆盖：容器加解密与篡改检测、白名单扫描与清单校验、导入回滚、Windows 子进程启动形态、路径解析（文件夹 / 文件 / 尾分隔符）、以及主机路由端到端。

## 目录结构

```text
dsh-data-migration/
├─ src/
│  ├─ index.ts                 # 主机半：回环受限路由、原生选择器、导出/预检/恢复编排
│  ├─ client/
│  │  ├─ index.tsx             # 浏览器半：设置区面板
│  │  └─ styles.ts             # 基于 DSH 设计令牌的样式表
│  └─ migration/
│     ├─ paths.ts              # 导出目标 / 导入来源的路径解析
│     ├─ constants.ts          # 容器与白名单常量
│     ├─ scanner.ts            # 白名单扫描、API Key env 名发现
│     ├─ manifest.ts           # 清单创建与校验
│     ├─ archive.ts            # tar.gz 创建与安全解包
│     ├─ crypto.ts             # scrypt / AES-GCM 容器
│     ├─ exporter.ts           # 导出编排
│     ├─ importer.ts           # 预检与恢复编排
│     ├─ snapshot.ts           # 恢复点、原子替换、回滚
│     ├─ env.ts                # 用户环境变量读写
│     └─ installer.ts          # profile 依赖安装
├─ tests/
├─ cordis.patch.yml
├─ tsdown.config.ts
└─ package.json
```

## 修复记录

本仓库由早期私有版本 `dsh-migration` 整理而来，主要修复：

| 问题 | 原因 | 处理 |
| --- | --- | --- |
| 页面“浏览…”按钮报错、导出提示 `Migration destination must use .dsh-migrate` | 浏览器半调用 `/api/dsh-migration/pick-directory`，但运行中的 `dsh web` 加载的是早于该路由的旧构建 | 统一路由前缀为 `/api/dsh-data-migration`，重建产物；并在 README 明确“改源码必须重新构建 + 重启” |
| 选择文件夹后仍必须手填 `.dsh-migrate` 才能导出 | 路径解析用 `resolve(value) !== value` 判断，尾部分隔符、`/`、`.` 段都被判为非法 | 新增 `src/migration/paths.ts`，改用 `isAbsolute` + `resolve` 归一化，并补 `tests/paths.test.ts` |
| 导入只能读取固定文件名 `backup.dsh-migrate` | 只有文件夹选择器，迁移包改名后无法导入 | 新增 `pick-file` 路由与“浏览文件…”按钮 |
| 自动安装依赖在 Windows 上总是 `spawn-failed` | `spawn('pnpm', …)` 无法直接执行 `.cmd` 垫片 | 新增 `spawnSpec()`，Windows 下经 `cmd.exe /d /s /c` 启动，并补 `PATHEXT` |
| UI 风格与当前页面不一致 | 内联样式硬编码颜色与圆角，缺少 hover/focus 状态 | 改为注入样式表，全部使用 `--dsw-alias-*` 设计令牌 |
| 客户端半与主机半容易脱节 | 仓库根目录手写 `client.js` 与 `src/client/index.ts` 各自维护，构建产物又是第三个文件 | `exports["./client"]` 直接指向构建产物 `lib/client.js`，删除手写副本 |

## 许可证

[MIT](LICENSE)。
