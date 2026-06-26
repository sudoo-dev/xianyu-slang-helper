# 发布流程 (CI → Chrome Web Store)

`.github/workflows/release.yml` 把「构建 + 加密 + 打包 + 上传」自动化。**前提是扩展已在
Chrome Web Store 手动发布过至少一次**（拿到 extension id），且配好下面 4 个 Secrets。

---

## 一、一次性配置（只做一次）

### 1. 拿到 Chrome Web Store API 凭据

1. 打开 [Google Cloud Console](https://console.cloud.google.com/) → 新建（或选一个）项目。
2. **APIs & Services → Library** → 搜索 **Chrome Web Store API** → Enable。
3. 配置 OAuth（新版叫 **Google Auth Platform**，已没有单独的 “OAuth consent screen” 页）：
   点 **Get started** → *App Information* 填应用名 + 支持邮箱 → ***Audience* 这一步选 `External`**
   （“External” 现在藏在这里；`Internal` 仅 Google Workspace 组织账号才有）→ 填联系邮箱 →
   同意 → 创建。完成后到左侧 **Audience → Test users → Add users**，把你管理扩展的那个
   Google 账号加进去（Testing 模式下只有测试用户能完成下一步授权）。
4. 左侧 **Clients → Create client** → Application type 选 **Desktop app** → 创建 →
   记下 **Client ID** 和 **Client secret**。
5. 换取 **refresh token**——最省事的方式，本地跑官方助手按提示操作：
   ```bash
   npx -y chrome-webstore-upload-keys
   ```
   它会引导你用浏览器授权，最后打印出 refresh token。（手动 curl 流程也行，但这个最快。）

### 2. 拿到 extension id

Chrome Web Store 开发者后台 → 选中你的扩展 → URL 里 `.../detail/<这一长串>` 就是 extension id。

### 3. 写入 GitHub Secrets

仓库 **Settings → Secrets and variables → Actions → New repository secret**，加 4 个：

| Secret 名 | 值 |
|---|---|
| `CHROME_EXTENSION_ID` | 扩展 id |
| `CHROME_CLIENT_ID` | OAuth client id |
| `CHROME_CLIENT_SECRET` | OAuth client secret |
| `CHROME_REFRESH_TOKEN` | 上一步拿到的 refresh token |

---

## 二、每次发版

1. 改完词典后，**把 `manifest.json` 和 `tools/dictionary.source.json` 的 `version` 改成同一个新版本号**
   （`package.mjs` 和 CI 都会强校验一致，不一致直接失败）。
2. 提交并打 tag（tag 号要和 version 对上，带 `v` 前缀）：
   ```bash
   git commit -am "release: v1.7.2"
   git tag v1.7.2
   git push && git push --tags
   ```
3. CI 自动跑：校验版本 → `node tools/package.mjs` → 打 zip → **上传为草稿** → 把 zip 附到 GitHub Release。
4. 去 [开发者后台](https://chrome.google.com/webstore/devconsole) 看一眼新版本，点 **Publish** 提交审核。

> **想跳过手动点发布**：在 Actions 页手动运行本工作流（workflow_dispatch），勾上 `publish=true`，
> CI 会直接提交审核。**但**这会把内容直接送审/上线，建议仅在你已本地 `git diff` 过词典后使用。

---

## 注意

- **审核仍在**：API 的「发布」只是自动提交，Google 照样人工审，通常几小时到几天，不是秒上线。
- **草稿是默认**：tag 触发永远只上传草稿，正是为了防止擦边词未经过目直接推给用户。
- **安全加固（可选）**：把 `mnao305/chrome-webstore-upload@v5`、`softprops/action-gh-release@v2`
  这类第三方 action 钉到具体 commit SHA，可防上游被篡改。
- **Edge 商店**：另有一套 Partner Center API，需要可再加一个 job，本工作流暂只发 Chrome。
