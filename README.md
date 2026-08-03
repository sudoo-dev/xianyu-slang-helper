# 闲鱼词典 (Xianyu Dictionary)

[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-%E5%AE%89%E8%A3%85%E9%97%B2%E9%B1%BC%E8%AF%8D%E5%85%B8-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/%E9%97%B2%E9%B1%BC%E8%AF%8D%E5%85%B8/kblfpfpjgbhakbjefandponpkflfjmei)

> 🎉 **已上架 Chrome 应用商店** — 👉 **[点此一键安装](https://chromewebstore.google.com/detail/%E9%97%B2%E9%B1%BC%E8%AF%8D%E5%85%B8/kblfpfpjgbhakbjefandponpkflfjmei)**

Chrome / Edge 浏览器扩展，帮你解决闲鱼上的"暗语搜不到、看不懂"问题：

- **搜索词翻译**：闲鱼搜索框输入正常词（`iPhone`、`茅台`、`谷子`），自动弹出对应暗语推荐，点击直接替换。
- **暗语解读**：商品标题/描述里的暗语自动加下划线高亮，悬停看含义。
- **独立翻译面板**：粘贴任意文本，正反向翻译，点击复制。
- **分类浏览**：16 个分类（电子产品/奢侈品/烟酒/球鞋/潮玩/谷圈/游戏/AI 服务/互联网/成色/议价/防坑/渠道/营销/交易/卡牌），可按分类筛选。
- **加密打包 🔒**：词典使用 AES-256-GCM 加密，scraper 无法 `grep` 出明文。
- **跟随版本更新**：词典随插件版本更新，依赖 Chrome 自动更新机制，无需远端拉取。

## 词典规模（v1.7.3）

- 16 分类
- 206 条目
- 674 个暗语变体

来源：知乎、Linux.do、X / Twitter、谷圈科普文、[search-sharp.com](https://search-sharp.com) 社区众包（经质量 + 政策过滤）等公开内容。**只收录二手交易类**暗语，不含涉违法暗号。

## 加密设计

| 层 | 说明 |
|----|------|
| 算法 | AES-256-GCM (Web Crypto API) |
| KDF | PBKDF2-SHA256, 100,000 轮 |
| Salt | 固定 16 字节, 与 build 脚本对齐 |
| IV | 每次构建随机生成 12 字节 |
| Key 来源 | 三段常量字节, 各自 XOR 不同 mask, 运行时拼接 |
| Key 存储 | 散落在 `data/crypto.js` 字节数组中, 无明文字符串 |
| 解密时机 | content script / popup 启动时, 在闭包内进行一次性解密 |
| 解密结果 | 仅保存在闭包变量, **不挂任何 window/self 属性**, 外部只能通过受控 API 单次查询 |

### 这能挡住什么？

- ✅ 自动化 scraper 用 `curl + jq + grep` 抓取扩展包提取词条
- ✅ 关键字检测脚本扫描 .crx 内容
- ✅ 普通逆向爱好者一眼读懂

### 这挡不住什么？

- ❌ 经验丰富的逆向工程师用 DevTools / 调试器一步步跟踪解密
- ❌ 注入 hook 拦截 `crypto.subtle.decrypt` 返回值

加密在浏览器扩展环境是**提高门槛**的手段，无法做到绝对保密 — key 必须能被代码访问，所以理论上一定可被还原。但相比明文 JSON，可以挡掉 95% 的爬虫脚本。

## 开发 vs 发布

加载器有两条路径，**自动**选哪条由文件是否存在决定：

| 模式 | tools/dictionary.source.json | 加载行为 |
|------|------------------------------|---------|
| 开发期 | 存在（明文） | 直接读明文，**免加密** |
| 发布期 | 不存在（打包脚本剔除） | 回落到 data/dictionary.enc.json，运行时解密 |

### 开发流程

直接编辑明文词典，浏览器刷新插件即生效，**不需要任何 build 步骤**：

```bash
$EDITOR tools/dictionary.source.json     # 改词条
# chrome://extensions/ → 刷新插件
```

popup 词典页会显示最新内容，content script 也会同步使用新词典。

### 发布流程

```bash
# 同步 manifest.version 与 source.version
# 然后:
node tools/package.mjs
```

脚本会:
1. 加密 `tools/dictionary.source.json` → `data/dictionary.enc.json`
2. 校验 manifest / source 版本对齐
3. 拷贝运行时文件到 `dist/xianyu-slang-helper/`，**剔除整个 tools/ 目录**
4. 安全检查：抽样 grep 关键词，确保 dist/ 无明文泄漏

最后打 zip 上传 Chrome Web Store。**必须在包目录内部打包**——`manifest.json` 要在 zip 根目录，
外面多套一层目录商店会直接拒收：

```bash
cd dist/xianyu-slang-helper && zip -qr ../xianyu-slang-helper-v1.7.3.zip .
```

（走 tag 触发 CI 发版的话这步不用管，工作流已经这么打了。）

### 单独再加密（不打包）

只想跑一次加密、不要 dist/：

```bash
node tools/encrypt-dict.mjs
```

### CI 自动发布

推送 `v*` tag（如 `v1.7.3`）即触发 GitHub Actions：校验版本一致 → 打包 → 上传到 Chrome Web Store（默认草稿，到后台手动 Publish）。一次性凭据配置见 [.github/RELEASING.md](.github/RELEASING.md)。

## 安装方式

### 方式 1：Chrome 应用商店（推荐）

👉 **[从 Chrome 应用商店安装闲鱼词典](https://chromewebstore.google.com/detail/%E9%97%B2%E9%B1%BC%E8%AF%8D%E5%85%B8/kblfpfpjgbhakbjefandponpkflfjmei)** — 点"添加至 Chrome"即可，安装后随浏览器自动更新。

### 方式 2：手动加载（开发者模式）

1. 到 [Releases 页面](https://github.com/sudoo-dev/xianyu-slang-helper/releases) 下载最新 `.zip` 并解压（或克隆本仓库）
2. 打开 `chrome://extensions/`，右上角开启"开发者模式"
3. "加载已解压的扩展程序" → 选 `xianyu-slang-helper` 文件夹
4. 访问 [goofish.com](https://www.goofish.com/) 即可生效

## 文件结构

```
xianyu-slang-helper/
├── manifest.json                # MV3
├── background.js                # Service worker (仅初始化设置)
├── content.js                   # 内容脚本: 搜索气泡 + 暗语高亮
├── content.css
├── popup.html / popup.css / popup.js
├── data/
│   ├── crypto.js                # 运行时 AES-GCM 解密 + 混淆 key
│   ├── dict-loader.js           # 受控查询 API, 闭包持有明文
│   └── dictionary.enc.json      # 加密词典 (build 产物, 发布时使用)
├── tools/                       # 仅开发期, 打包时整目录剔除
│   ├── dictionary.source.json   # 词典源 (人类可读, 维护者编辑此处)
│   ├── encrypt-dict.mjs         # 单独加密脚本
│   ├── package.mjs              # 发布打包脚本 (加密 + 拷贝 + 安全检查)
│   └── fetch-searchsharp.mjs    # 从 search-sharp.com 同步众包暗语 (sync-searchsharp skill)
├── dist/                        # 打包产物 (gitignored, 上传 Web Store 用)
├── icons/
└── README.md
```

## 隐私

- **零外部请求**：除了内置的加密 JSON，不向任何外部服务器发请求
- **零数据收集**：不上报使用数据
- **生效域名限制**：仅在 goofish.com / xianyu.com / 2.taobao.com 三个域名运行

## 来源致谢

- [闲鱼"暗语"你知道吗？(知乎)](https://zhuanlan.zhihu.com/p/112140534)
- [大众版暗网？闲鱼APP上的暗语 (环信)](https://www.easemob.com/news/8996)
- [闲鱼有哪些常见的术语和暗语？ (红草笔记)](https://www.redcao.com/archives/18810.html)
- [可以分享你知道的闲鱼暗语吗 (Linux.do)](https://linux.do/t/topic/972037)
- [谷圈名词科普 (知乎)](https://zhuanlan.zhihu.com/p/119634849)
- [全是"暗语"的谷圈 (界面新闻)](https://www.jiemian.com/article/6953041.html)
- [SearchSharp (search-sharp.com)](https://search-sharp.com) — 社区众包的叫法/别名，经质量 + 政策过滤后并入
- [r/goofish 闲鱼暗语字典分享 (Reddit)](https://www.reddit.com/r/goofish/comments/1ps0bnt/) — 待并入（受 Reddit 反爬限制，需手工提取）

## License

MIT
