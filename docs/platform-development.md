# 平台开发与发布规则

本文件适用于当前平台 fork。开始工作前读取本文件；这里的分支、标签、构建、发布与部署约定替代上游正文中的同类流程，其他工程规范继续适用。用户当前明确指令优先。

## 分支与代码保全

- 长期开发分支统一为 `dev/platform`，不在分支名中编码版本号。
- 日常任务从 `dev/platform` 派生 `feat/<主题>` 或 `fix/<主题>`，验证后合回 `dev/platform`。
- 共享分支使用 merge 保留历史；不 rebase、强推、reset 或删除旧分支/标签来完成同步。
- 整理分支前检查实际远端引用、本地未提交文件和 stash。保留历史引用并生成可验证的备份；提交祖先关系不能证明经过 squash 的代码已完整覆盖。
- 使用明确的远端名与引用。更新分支用 `git fetch --no-tags`，只拉取指定分支；不使用隐式 `git pull`。

## 标签与配套关系

- 正式源码 tag 从已验收稳定分支生成，使用 annotated tag，并核对完整 SHA 与远端 peeled commit 一致。
- Botmux 平台源码统一命名为 `acp-vX.Y.Z-platform.N`；Dev 与 Worker 使用同一命名空间，更新范围由发行清单描述。历史 `acp-dev-*` 和 `v*-platform.*` 标签保留，不改名或移动。
- Control Plane 源码 tag 使用 `vX.Y.Z`；发行清单/封装工具快照继续使用 `acp-release-*`。
- Botmux 上游版本 tag 从 `upstream` 按完整名称获取，保存到本地 `refs/tags/upstream/vX.Y.Z`；平台 tag 从自己的 `origin` 精确获取。同名标签不一致时停止核对，不覆盖。
- 分别记录 Git 源码 tag、完整 SHA、镜像 tag 和每平台 digest。`release.json` 的 `sources.agent`、`sources.dev`、`sources.control` 记录真实来源；组件可独立更新。
- 只使用已发布且读回验证的镜像 digest 更新正式 `release.json`。构建计划与运行进度保存为独立文件；未完成构建不改变当前可部署发行清单。

## 构建、发布和运行服务

- 验证使用锁定依赖与项目支持的 Bun 版本；不通过安装到共享 symlink 依赖目录改变其他 checkout。
- 源码修改、构建或推送不会自动重启现有 Bot/平台服务。运行服务替换须在用户请求部署时执行，保留原配置、数据和回滚坐标。
- 全量发布覆盖 artifact、Dev、四种 Worker、Control Plane、Chrome/Firefox 浏览器，以及内容寻址 base 和固定 execd。每个镜像验证 Linux AMD64/ARM64 实际架构，不能仅通过标签后缀判断。
- 正式 ACR 交付使用 Docker schema2/gzip 和双架构 manifest list，发布后读回验证。固定 base/execd 不覆盖原标签；已存在目标必须核对内容后才能复用。
- 后台发布使用固定源码 tag/SHA 的独立 checkout，保留日志、阶段状态、失败退出码和最终清单，不读取或修改现有部署私密配置，不自动部署。
- 部署 Skill 先更新 canonical `agent-skills/skills/acp-registry-deploy`，验证后合入 `main`，再同步仓库内副本和安装副本。规则/工具可以先更新并保留旧的已验证发行清单。
- 镜像完成并验证后提交新发行清单；从 clean 资产提交打包，MANIFEST 记录输入提交，bundle 另行提交，源码 tag 保持不动。

## Botmux 的上游与稳定分支

- `origin` 是平台 fork；`upstream` 是 deepcoldy/botmux，只读取与合入，不推送平台改动。
- `origin/master` 保持上游镜像，平台稳定合入分支为 `stable/platform`。
- 同步从 `dev/platform` 建立 `sync/upstream-<日期>`，merge 指定的 `upstream/master` SHA，解决冲突并验证后合回 `dev/platform`，验收后再合入 `stable/platform`。
- 保留上游 `CLAUDE.md` 正文与 `AGENTS.md -> CLAUDE.md`；平台规则仅通过固定入口引入。本文件为 fork 专有规则，合并时逐段解决冲突，不能整文件选择 ours/theirs。
- 平台 tag 使用 `acp-*` 前缀，不触发上游 `v*` npm/GitHub Release 流程。

## 本轮同步兼容边界

托管Agent池运行暂不支持运行中DAG修订或切换为外部Bot执行；操作在写入前明确拒绝，修改需求通过克隆新Workflow并重新审批完成。普通Botmux的非池运行保留上游动态DAG与Bot执行功能。

## workflow-core 与平台兼容

workflow-core 保留实际值依赖与公开类型的精确允许列表。新增叶子模块须确认无 daemon、Lark SDK、配置读取或 Worker 启动依赖；纯路径 DTO 和 Node 文件/摘要工具可以在核对依赖图后逐项加入，不能关闭或改成宽泛前缀允许。Agent 池与外部群 Bot 分配在架构提示生成前拒绝混用；资源补建只显示 `PLATFORM_CLI_IDS` 中当前维护的四类 Worker。

## Workflow 项目工作区边界

- Control 的挂载根是访问范围，不是每次 Workflow 的执行工作区。托管 Workflow 创建、复制和模板启动显式选择 Agent 池，并冻结池对应的工作区；不自动创建或沿用默认池。
- `workspace.selection.json` 保存池、Control 内项目相对根、真实访问证据与绑定摘要；真人 DAG 卡片及 `run.json` 同时冻结该选择。审批后改变池、挂载或文件摘要不能继续使用旧授权。
- hostPath 按规范化后的目录边界与真实宿主检查判定父子关系，不使用字符串前缀；命名 volume 仅接受相同卷身份。Control 可以只读访问项目，不因此扩大 Worker 的可写范围。
- Control 的 `/workspace/project-a/file` 与 Worker 的 `/workspace/file` 是不同坐标。结构化项目路径先转相对路径，再映射到 Worker 项目根；执行任务携带明确的坐标上下文，不盲目改写任意任务文本。跨实例的声明输入仍通过任务本地副本、摘要与大小限制传输。
- 托管 Workflow 通过原生飞书/CLI 链路准备需求、DAG并等待真实飞书 DAG 卡片审批；未批准或被拒绝时，不写运行授权或协作授权。新增托管 Dashboard 草稿创建、复制和编辑入口已撤除，不能用页面确认替代真人审批。普通非 ACP Workflow 保留原行为。
- 新增的托管模板→Dashboard 草稿启动桥及 `workflow run --resume-draft` 已撤除。托管池 Saved Workflow 直接启动尚未支持，在创建目录前明确拒绝；使用原生 `workflow new "<目标>" --pool <poolId>` 重新编排并真人审批，不继承旧池/授权。普通非托管 Saved Workflow 保留本群/当前 Bot 全局的原作用域与标准命令，不将所有 Control 请求转入新草稿入口。

## Worker 配置更新边界

单 CLI Worker 在「修改配置」中仅改模型或认证时，保存走 MCP 同步与原地配置应用，不调用容器 `/upgrade`。Codex/ZCode 支持 API Key 与原生 OAuth 选择，OAuth 模型留空表示原生默认；选择认证方式本身不发起 OAuth 登录。修改工作区、只读挂载或镜像才进入显式重建路径，须保留确认与空闲守卫。

模型配置同步可能停止再启动绑定的 Bot daemon；持久 tmux CLI 会话可以保留，因此不能把「已同步」解释成所有已有 CLI 已被重启或即时换模。新启动的 CLI 读取新配置。
