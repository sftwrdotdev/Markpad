<div align="center">
  <img src="src-tauri/icons/128x128.png" width="128" alt="Markpad Icon" />
  <h1>Markpad</h1>
  <p><b>Markdown 界的记事本</b></p>

  [![GitHub Release](https://img.shields.io/github/v/release/sftwrdotdev/Markpad?style=flat-square)](https://github.com/sftwrdotdev/Markpad/releases/latest)

  <p>一个轻量、克制的 Markdown 阅读器与编辑器，同时支持 Windows、macOS 和 Linux。</p>

  <a href="https://markpad.dev">官网</a> // <a href="#下载">下载</a> // <a href="#markpad-能渲染什么">Markpad 能渲染什么</a> // <a href="https://github.com/sftwrdotdev/Markpad/issues">反馈问题</a> // <a href="README.md">English</a>
</div>

<br />

![demo](pics/demo.gif)

## 功能

**阅读**
- GitHub 风格渲染，代码块带语法高亮
- 数学公式（KaTeX）与图表（Mermaid）
- 目录跟随滚动，当前标题始终居中
- 按标题折叠，以及把其余一切收起来的禅模式
- 内容缩放、字体排版自定义、主题自定义（可导入 VS Code 主题）

**编辑**
- Monaco —— 与 VS Code 同一个编辑器 —— 并支持 Vim 模式
- 分屏，两侧按行同步
- 写链接时自动补全标题，格式工具栏可自定义
- 图片直接粘贴进文档；文件拖进来即打开

**文档**
- 多标签页、多窗口、窗口标签，以及会自己回来的会话
- 文件在磁盘上被改动时自动重载
- 导出 HTML、打印 PDF
- 在标准 Markdown 之外还支持 wikilink、嵌入和提示框 —— 见下面的
  **[Markpad 能渲染什么](#markpad-能渲染什么)**

**其余**
- Windows、macOS、Linux
- 约 10MB 内存占用，无遥测，自由开源
- 26 种界面语言

## 下载

### 包管理器

#### Windows（Chocolatey）

```powershell
choco install markpad-app
```

#### Linux（Snap）

```bash
sudo snap install markpad 
```

### 直接下载

下面每个文件都在[最新发行版](https://github.com/sftwrdotdev/Markpad/releases/latest)页面上，也可以从 [markpad.sftwr.dev](https://markpad.sftwr.dev) 获取。

| 系统 | 芯片 | 文件 | |
|---|---|---|---|
| **Windows** | Intel / AMD | `Markpad_x.y.z_x64-setup.exe` | 安装版 |
| | Intel / AMD | `Markpad_x.y.z_x64.exe` | 免安装便携版 |
| | ARM64 | `Markpad_x.y.z_arm64-setup.exe` | 安装版 |
| | ARM64 | `Markpad_x.y.z_arm64.exe` | 便携版 |
| **macOS** | Intel **和** Apple Silicon | `Markpad_x.y.z_universal.dmg` | 通用二进制，一个文件通吃 |
| **Linux** | x86-64 | `Markpad_x.y.z_amd64.AppImage` | 免安装便携版 |
| | x86-64 | `Markpad_x.y.z_amd64.deb` | Debian、Ubuntu |
| | x86-64 | `Markpad-x.y.z-1.x86_64.rpm` | Fedora、RHEL、openSUSE |

两个 Windows 文件的区别只在装不装：`-setup.exe` 会把 Markpad 装进 Program Files 和开始菜单，不带 `-setup` 的那个放哪儿就在哪儿运行。

> 通过 `.dmg`（macOS）、`*-setup.exe`（Windows NSIS）或 `.AppImage`（Linux）直接安装之后，Markpad 会通过应用内的 *检查更新…*（macOS 在应用菜单，其它平台在设置里）从 GitHub 发行版自更新。Snap 和 Chocolatey 的更新由这两个包管理器负责。
>
> **`.deb` 和 `.rpm` 是一次性安装。** `tauri-plugin-updater` 替换不了由包管理器装上的文件，也没有 apt 或 dnf 源可以更新 —— 升级要去发行页面下载新的安装包。*检查更新…* 会认出这类安装，直接告诉你更新从哪来，而不是给你一个装不上的更新（[#570](https://github.com/sftwrdotdev/Markpad/issues/570)）。

## Markpad 能渲染什么

Markpad 能渲染的每一种语法都在一份文档里 —— [**下载 `markdown-syntax.zh-CN.md`**](https://raw.githubusercontent.com/sftwrdotdev/Markpad/master/samples/markdown-syntax.zh-CN.md) 用 Markpad 打开：预览里是每一项真的渲染出来的样子，旁边的编辑器里是它怎么写的（也可以先[在 GitHub 上读](samples/markdown-syntax.zh-CN.md)）。把同一个文件交给 AI，它就完整知道 Markpad 能渲染什么：可以让它帮你把手上的文档重新排版，也可以让它用满这一整套写一份新的——提示框、表格、脚注、公式、图表——再拿 Markpad 打开。

## 从源码构建

- 克隆本仓库
- 运行 `npm install` 安装依赖
- 运行 `npm run tauri build` 构建可执行文件

### macOS 隔离测试包

如果想在本地验证而不打开、也不覆盖 `/Applications/Markpad.app`，可以构建一个使用独立标识符的、仅供测试的未签名应用：

```bash
MARKPAD_TEST_BUNDLE_ID=dev.example.markpad.test npm run build:test-bundle
```

产物在 `dist/test-bundle/`。它不是可分发的发行版：既没有 Developer ID 公证，也没有 Windows Authenticode 签名。

## 问题与反馈

发现 bug、有功能建议，或者只是想说点什么，都欢迎[提一个 issue](https://github.com/sftwrdotdev/Markpad/issues/new/choose)。Markpad 在持续开发中，我们很乐意听到用户的声音。

## 参与贡献

欢迎任何形式的贡献。Markpad 基于 SvelteKit 和 Tauri 构建。

1. **Fork 并克隆**本仓库
2. **安装依赖**：`npm install`
3. **启动开发服务**：`npm run tauri dev`（在本地运行 Tauri 应用）
4. **做出你的修改**，并确保类型检查通过：`npm run check`
5. **发起 Pull Request**！

请让代码风格与现有代码保持一致，并为新功能补上说明。

## 截图

#### 分屏
![split view](pics/splitview.png)
#### 编辑器工具栏
![editor toolbar](pics/2.7.0/editor-toolbar.png)
#### 主页
![home page](pics/home.png)
#### 极简分屏
![split view minimal](pics/splitview-minimal.png)
#### 代码块
![code block](pics/codeblock.png)
#### 浅色模式
![light mode](pics/lightmode.png)
#### 设置
![settings](pics/2.7.0/editor-settings.png)
#### 禅模式
![zen mode](pics/zenmode-view.png)
#### 主题设置
![theme setting](pics/theme-setting.png)
#### 目录
![table of contents](pics/2.7.0/floating-toc.png)
#### 主题示例
![theme example](pics/theme-example.png)
#### 窗口标签
![window tag](pics/2.7.0/window-tag.png)
#### 拖放
![drag and drop](pics/drag-and-drop.png)
