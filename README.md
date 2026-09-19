# 剧透弹幕AI过滤器

一个运行在 Chrome / Chromium 浏览器中的 B 站弹幕过滤扩展。本分支使用 **TypeSafe Jev 1.13 + OpenRouter Decisions API**：发送去重后的弹幕，读取每条弹幕的剧透得分，达到设置的阈值时替换或隐藏。

> 由于 AI 不会分析视频内容（考虑到成本和速度），只分析弹幕本身，判断可能出现误判或漏判，旨在尽可能降低剧透弹幕对观看体验的影响。

## 功能

- 支持 B 站普通视频页和番剧播放页。
- 支持手动过滤和自动处理；开启自动模式后会立即处理当前视频，并在刷新或切换视频后继续自动运行。
- Jev 专用接入，只需填写 OpenRouter API Key；无需 Base URL、模型名称或生成参数。
- 可调整屏蔽阈值、单批弹幕数量、请求并发数、请求超时和屏蔽后的替换文本。
- 发送前按弹幕文本去重，减少重复内容消耗的 token。
- 仅缓存上一次完整分析的视频，保留全部弹幕文本、时间和概率；刷新同一视频会自动复用，不再请求 AI。
- 主面板提供 10 档概率直方图，阈值随时可调，实时更新屏蔽效果、数量和详情。
- 每批返回立即显示分析进度、耗时和输入 Token，不显示费用或固定风险数量。
- 可以从直方图标题旁的列表图标查看全部弹幕及概率，按时间或概率升降序排列，并跳转到其出现时间。详情采用虚拟列表，只渲染可见区域附近的条目，滚动离开的条目会卸载。

## 安装

本分支为 Jev 试用版，尚未发布到 Releases。当前请切换到 `codex/jev-decisions`，运行 `npm ci`、`npm run build`，再在扩展管理页加载 `dist` 目录。更新现有扩展后还需要刷新 B 站页面。

正式发布后可按以下方式安装（旧 Release 不包含本次 Jev 改造）：

1. 在仓库的 Releases 页面下载发布包 `spoiler-barrage-ai-filter-vX.Y.Z.zip`。
2. 将 ZIP 解压到一个固定目录，后续不要随意移动或删除该目录。
3. 以 Chrome 游览器为例（其它游览器也差不多），在 Chrome 地址栏打开 `chrome://extensions/`。
4. 开启右上角的“开发者模式”。
5. 点击“加载已解压的扩展程序”，选择刚刚解压的目录。
6. 打开或刷新一个 B 站视频页。

## 使用方法

1. 打开 B 站普通视频或番剧播放页。
2. 点击播放器弹幕设置按钮旁的机器人图标。
3. 点击面板右上角的设置按钮，填写 [OpenRouter](https://openrouter.ai/settings/keys) 签发的 API Key，确保账户有可用额度。
4. 点击“测试”：插件会发送一条固定测试弹幕，显示连接状态和耗时。
5. 返回主面板，开始分析。

默认屏蔽阈值为 **0.70**（得分 ≥ 阈值时屏蔽）。主面板的滑块和数字输入框可在 0～1 之间随时调整，无需重新分析或请求 AI。提高阈值会还原不再需要屏蔽的可见弹幕，降低阈值会立即应用新屏蔽规则；“已屏蔽”百分比同步变化；详情始终展示全部已分析弹幕。阈值越低屏蔽越多，0 会屏蔽全部，1 仅屏蔽得分恰为 1 的弹幕。

直方图按原始弹幕条数统计，重复弹幕也计数。区间左闭右开，最后一档包含 1；蓝色部分是当前阈值下被屏蔽的数量，灰色部分是保留数量。这个得分不是经过本项目真实弹幕数据校准后的正确率。

默认每批最多 **1000 条、并发 10、超时 120 秒**。每批允许 1～1000 条，并发允许 1～16；按配置条数分批，不再用 48 KB 请求体大小提前拆批。实际模型输入上限仍由服务端约束，遇到输入过大错误时应调低批量；异常长的单条文本仍会在本地拒绝。限流或临时过载会遵循 Retry-After 退避，最多重试 2 次；120 秒包含本批重试等待。失败批次不会被当成“全部剧透”，分析会报错并取消其他未完成请求。已有自定义设置保持不变，可在设置中恢复默认值。

缓存只占一个视频槽位，新的完整分析成功后覆盖上一个。缓存链接会移除 query 和 fragment，并额外核对 cid，避免追踪参数干扰以及不同分 P、不同集混用结果。手动模式刷新也会自动恢复命中的结果；点击“重新分析”则强制重新请求 AI。停止、失败或弹幕拉取不完整不会覆盖上一次完整缓存。缓存命中后不会拉取新增弹幕，需要更新时请重新分析。

从旧版切换时需要重新填写 OpenRouter Key。旧模型的 Key 和生成参数不会沿用，旧分析缓存会在 IndexedDB 升级时清理。面板显隐状态仍然保留。

## Jev 如何判定

固定端点为 `https://openrouter.ai/api/alpha/decisions`，固定模型为 `typesafe/jev-1.13`。请求格式是 `state + questions`，不是聊天接口。

`state` 放共享判断规则，每个 `questions.dm_N` 是一个 `noul` 问题，在 `instructions.danmaku` 中独立携带一条弹幕。返回 `answers.dm_N.noul`（0～1），由插件按 ID 映射回文本，再按阈值决定是否屏蔽；模型不需要复述原文或生成 JSON 文本。没有视频标题、出现时间或视频内容输入。

默认共享规则和逐条问题集中位于 `src/services/prompts.ts`。设置面板中的“系统提示词”编辑的是发送到 `state` 的共享规则，支持恢复默认；编辑后离开输入框自动保存，重新分析生效，留空会恢复默认。逐条问题固定为“这条弹幕是否存在剧透的风险？”，保留在 `instructions.question` 中，遵循官方对直接是非问题的建议。

缓存按模型、提示词内容和判断问题区分；改过提示词不会复用旧规则的缓存。正在运行的分析始终使用启动时的提示词。当前模型优先针对英语训练，中文梗、反话、暗示仍需实测；换模型不保证准确率提升。

官方资料：[Jev 模型与价格](https://openrouter.ai/typesafe/jev-1.13)、[Noul 的含义](https://docs.typesafe.ai/primitives/noul)、[模型语言支持和限制](https://docs.typesafe.ai/models)。本接口目前为 alpha，后续可能调整。

## 数据与隐私

- API Key 保存在当前浏览器扩展的 `chrome.storage.local` 中。
- 分析时，去重后的弹幕文本发送给 OpenRouter / TypeSafe；不会发送视频标题和弹幕出现时间。
- 上一次视频的规范化链接、cid、完整弹幕文本、时间和概率保存在扩展自己的 IndexedDB 中，可在设置面板清空；不再使用跨视频全局哈希缓存。
- 不将私有 Key 写入源码、构建产物或发布包；本地接入文档 `jev-openrouter-integration.md` 已列入 `.gitignore`。

## 开发命令

```powershell
npm ci                    # 安装锁定版本的依赖
npm run typecheck         # TypeScript / Vue 类型检查
npm test                  # 离线协议、缓存、并发、停止和重试测试，不消耗额度
npm run build             # 构建到 dist
npm run icons             # 从 SVG 源文件重新生成各尺寸 PNG 图标
npm run package:extension # 检查、构建并生成 release/*.zip
```

在线小样本测试（会消耗少量额度）：设置 `OPENROUTER_API_KEY` 环境变量后运行 `npm run test:jev-live`。Windows 也可以用已有的本地接入文档：

```powershell
npm.cmd run test:jev-live -- --key-file jev-openrouter-integration.md
```

测试使用 `tests/jev-samples.json` 中的人工构造样本，输出逐条得分、耗时和实际计费。它是接入检查，不是准确率基准。可加 `--batch-size 50` 检查 50 个问题的单批开销（会循环使用样本）。正式评估应使用独立标注的真实弹幕集。

本地 UI 预览：运行 `npm exec vite -- --host 127.0.0.1`，打开 `http://127.0.0.1:5173/tests/preview.html`，用模拟弹幕检查阈值、直方图和可见弹幕恢复。不加载真实 Key，也不参与扩展构建。

## 项目结构

```text
components/                 Vue 面板组件
assets/extension-icon.svg   扩展图标源文件
public/                     Manifest 与构建时复制的静态资源
scripts/                    图标生成和发布打包脚本
src/extension/              Chrome MV3 运行时、后台脚本和消息协议
src/services/               弹幕获取、AI 分类、缓存与过滤逻辑
main.js                     页面入口和生命周期
vite.config.mjs             内容脚本与后台脚本构建配置
```

## 开源许可

本项目采用 [MIT License](./LICENSE) 开源。

作者：[F-know](https://github.com/F-know)
