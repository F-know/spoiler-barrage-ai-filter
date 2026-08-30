# 剧透弹幕AI过滤器

一个运行在 Chrome / Chromium 浏览器中的 B 站弹幕过滤扩展。它会读取当前视频的弹幕，将弹幕文本和视频标题发送到用户自行配置的 OpenAI 兼容接口，并把模型判断为存在剧透风险的弹幕替换或隐藏。

> 由于 AI 不会分析视频内容（考虑到成本和速度），只分析弹幕本身，判断可能出现误判或漏判，旨在尽可能降低剧透弹幕对观看体验的影响。

## 功能

- 支持 B 站普通视频页和番剧播放页。
- 支持手动过滤和自动处理；开启自动模式后会立即处理当前视频，并在刷新或切换视频后继续自动运行。
- 可配置任意 OpenAI `chat/completions` 兼容接口、模型名称和 API Key。
- 可调整单批弹幕数量、请求并发数和屏蔽后的替换文本。
- 按视频缓存近期分析结果，避免重复调用接口；缓存保存在扩展自己的 IndexedDB 中。
- 可以查看被过滤弹幕，并跳转到其出现时间。

## 安装

1. 在仓库的 Releases 页面下载发布包 `spoiler-barrage-ai-filter-vX.Y.Z.zip`。
2. 将 ZIP 解压到一个固定目录，后续不要随意移动或删除该目录。
3. 以 Chrome 游览器为例（其它游览器也差不多），在 Chrome 地址栏打开 `chrome://extensions/`。
4. 开启右上角的“开发者模式”。
5. 点击“加载已解压的扩展程序”，选择刚刚解压的目录。
6. 打开或刷新一个 B 站视频页。

## 使用方法

1. 打开 B 站普通视频或番剧播放页。
2. 点击播放器弹幕设置按钮旁的机器人图标。
3. 点击面板右上角的设置按钮，填写：
   - 接口地址：例如服务商提供的 API Base URL，也可以直接填写完整的 `/chat/completions` 地址。
   - 模型名称：服务商支持的模型 ID。
   - API Key：对应服务商签发的密钥。
4. 点击“测试”确认接口可用。
5. 返回主面板，开始过滤。

分析会消耗所选 AI 服务商的额度。批量大小和并发数过高时，服务商可能返回限流错误；遇到这种情况请降低并发数。

## 数据与隐私

- API Key 保存在当前浏览器扩展的 `chrome.storage.local` 中。
- 分析时，当前视频标题和弹幕文本会发送到用户配置的 AI 接口。请根据接口服务商的隐私政策决定是否使用。
- 视频分析缓存保存在扩展自己的 IndexedDB 中，默认保留最近 3 个视频，可在设置面板调整数量或手动清空。

## 开发命令

```powershell
npm ci                    # 安装锁定版本的依赖
npm run typecheck         # TypeScript / Vue 类型检查
npm run build             # 构建到 dist
npm run icons             # 从 SVG 源文件重新生成各尺寸 PNG 图标
npm run package:extension # 检查、构建并生成 release/*.zip
```

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
