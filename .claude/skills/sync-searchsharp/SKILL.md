---
name: sync-searchsharp
description: >-
  Pull crowd-sourced second-hand-marketplace slang from search-sharp.com, quality- and
  policy-filter it, and merge the genuinely new terms into the 闲鱼词典 / xianyu-slang-helper
  dictionary (tools/dictionary.source.json), then package a release. Use this whenever the
  user wants to update, sync, refresh, or grow the slang dictionary from SearchSharp — e.g.
  "更新词典", "同步暗语", "从 search-sharp 抓新词", "import slang from searchsharp",
  "pull the latest 别名/叫法", "拉一下外部词库". Also use when the user mentions
  fetching/merging external slang data into this extension. Do NOT use for plain manual
  edits to the dictionary, for general questions about what a slang term means, or for the
  normal release/packaging flow when no external fetch is involved.
---

# Sync slang from SearchSharp

## What this does and why it's careful

`search-sharp.com` ("搜全它的所有叫法") is a crowd-sourced site of the same marketplace slang
this extension ships. Its public read API gives `product → aliases[] + keywords[]`, which maps
onto our `normal → slangs[]` schema. So importing is easy — the hard part is *judgment*, and
that's why this is a skill (a human is present each run), not a cron job.

Three properties of the source shape the whole workflow:

1. **It's user-voted UGC, so it's noisy.** Upvoted ≠ real search term. Real aliases
   (推特→X, 网飞/奈飞→Netflix) sit right next to memes (微信 picking up "屎山", "口香糖", "张小龙").
   Vote thresholds thin the junk but can't remove popular jokes — a human has to skim.
2. **It contains Web Store policy landmines.** Crowd data is full of exactly the grey-area
   terms we deliberately pulled out into `tools/dictionary.grey-area.json` (sex/上门, drugs,
   weapons, 外挂, age-coins). Shipping those risks extension rejection/takedown. The fetcher
   excludes them by a denylist and only *reports* them; they are never auto-merged.
3. **It has no categories** (everything is "用户添加"). New concepts arrive uncategorized and
   need filing into our 15 categories.

So: **always fetch → review with the user → merge → clean → (version-bump) → package.** Never
blind-merge, and never auto-publish.

## Workflow

Run everything from the repo root. Requires Node 18+ (the fetcher uses built-in `fetch`).

### 1. Fetch & preview — never skip this

```bash
node tools/fetch-searchsharp.mjs --min-score 2
```

This crawls the API (rate-limited, ~179 products today), filters, writes
`tools/searchsharp.staged.json`, and prints a report. **It does not touch the dictionary.**
For a first bulk import, suggest a stricter `--min-score 3` (or higher) to cut meme noise up
front — you can always loosen later.

### 2. Review the staged report with the user

Read `tools/searchsharp.staged.json` and walk the user through its three buckets:

- **`newVariantsForExisting`** — additions to entries we already have (safest). Still skim for
  memes before accepting.
- **`newEntries`** — brand-new concepts, **uncategorized**. Quality varies wildly. Triage:
  keep the real ones, drop the jokes, and propose which existing category each keeper belongs
  to. Read `tools/dictionary.source.json` for the live category list (electronics, luxury,
  tobacco-alcohol, sneakers, transaction, …) — don't dump everything into one bucket if you
  can sort it sensibly.
- **`filteredForPolicy`** — **excluded** by the policy denylist. Show the user what was dropped
  so nothing is silent. Default is to keep these out. Only re-include with explicit user
  consent, and remember these are the same class of terms that live in
  `dictionary.grey-area.json` for compliance reasons.

### 3. Merge — pick by volume

- **Bulk / first run:** `node tools/fetch-searchsharp.mjs --apply`
  Appends the safe variants to existing entries and drops all new concepts into a `社区补充`
  (community) category, then updates `updatedAt`. Then help the user re-file the `社区补充`
  entries into proper categories and delete the junk, editing `source.json` directly.
- **Incremental / small batch:** skip `--apply` and edit `source.json` directly from the
  reviewed list — it yields a much cleaner git diff.

`--apply` never writes policy-filtered items.

### 4. Quality pass on `source.json`

The dictionary *is* the product. After merging, dedupe, delete remaining memes/wrong entries,
and confirm categories make sense. Eyeball `git diff tools/dictionary.source.json`.

### 5. Package / publish (only when releasing to users)

Chrome only pushes an update on a new version, so a release needs a version bump:

1. Bump `version` to the same value in **both** `manifest.json` and
   `tools/dictionary.source.json` — `package.mjs` hard-fails if they differ.
2. `node tools/package.mjs` — re-encrypts the dictionary, builds `dist/`, and runs the
   no-plaintext-leak safety checks.
3. `cd dist && zip -r xianyu-slang-helper-v<version>.zip xianyu-slang-helper`, then upload to
   the Chrome Web Store. **You do the final upload — this skill never auto-publishes.**
4. If not already there, add SearchSharp to the README "来源致谢" (credits) list.

## Tuning the filters

- **Quality:** `--min-score N` is the minimum net upvotes (`up − down`) a keyword needs.
  Higher = cleaner but fewer terms.
- **Policy:** edit `POLICY_RULES` in `tools/fetch-searchsharp.mjs`. It intentionally errs
  toward over-blocking — a policy term leaking into the published package is far costlier than
  one good term wrongly dropped (which the user can re-add by hand).

## Caveats to keep in mind

- The fetcher rate-limits (~400 ms/request) because the site sits behind Cloudflare. Don't
  strip that out.
- This republishes another site's crowd-sourced compilation into the user's Web Store listing.
  No license or ToS was found on the site (which defaults to all-rights-reserved, not
  free-to-reuse). Keep the data filtered, keep attribution, and treat the decision to ship it
  as the user's to own.
