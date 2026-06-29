# Folder-Driven Media Gallery

An auto-updating photo/video gallery whose navigation mirrors a Dropbox folder
tree, served cheaply via Cloudflare R2 + CDN, with **no database**.

```
Dropbox "Gavin Media/"  ──rclone (GitHub Action)──▶  R2 bucket "gavin-media"
                                                          │
                              Cloudflare Worker (gallery-api) ──lists folders──▶ JSON
                                                          │
                                      gallery.html (on Render) ──renders──▶ visitors
                              media bytes served from media.<domain> (CDN, zero egress)
```

**Adding content = dropping a file in Dropbox.** No code changes, no redeploys.

## Pieces in this repo

| Path | What it is |
|---|---|
| `gallery.html` | Front-end gallery (hash routing, albums, masonry, lightbox, embeds, filters, Spotlight). Served by Render. |
| `worker/src/worker.js` | Cloudflare Worker — lists one R2 folder level as JSON. |
| `worker/wrangler.toml` | Worker config (R2 binding + `MEDIA_BASE`, `ALLOW_ORIGIN`). |
| `.github/workflows/sync.yml` | Scheduled rclone mirror, Dropbox → R2 (+ optional cache purge). |

---

## One-time setup

### 1. Cloudflare R2 bucket + custom domain

1. Create an R2 bucket named **`gavin-media`**.
2. Attach a **custom domain** to it (e.g. `media.breakthestageboy.com`) so bytes
   are CDN-cached with zero egress. **Do not use the `*.r2.dev` URL in
   production** — it's rate-limited and uncached.
3. Create an **R2 API token** (Access Key ID + Secret) for rclone.

### 2. Deploy the Worker

```bash
cd worker
npm install
npx wrangler login        # opens browser; authorize once
npx wrangler deploy
```

`wrangler deploy` prints the Worker URL when it finishes — both the generated
`https://gallery-api.<subdomain>.workers.dev` and any custom domain. You can
also find it later in the Cloudflare dashboard under **Workers & Pages →
gallery-api**.

**Custom domain (recommended):** in the dashboard open **Workers & Pages →
gallery-api → Settings → Domains & Routes → Add → Custom domain** and enter
**`api.breakthestageboy.com`**. The front-end is already configured to use this
URL, so no front-end change is needed once the domain is attached.

Verify:
```bash
curl "https://api.breakthestageboy.com/api/list?path="
curl "https://api.breakthestageboy.com/api/list?path=2026-competition"
```

### 3. Point the front-end at the Worker

`API_BASE` in `gallery.html` is already set to `https://api.breakthestageboy.com`.
If you use a different URL instead, edit it near the top of the `<script>`, or
test any URL without editing via `gallery.html?api=<worker-url>`.

### 4. Set up the sync (Dropbox → R2)

Build the rclone config **locally** (`rclone config`) with two remotes — a
`dropbox` remote and an `r2` S3 remote — then copy the whole config:

```bash
rclone config show
```

Add it as the GitHub repo secret **`RCLONE_CONF`** (Settings → Secrets and
variables → Actions). The workflow runs every ~10 min and on manual
**Run workflow**.

```ini
[dropbox]
type = dropbox
token = {"access_token":"...","refresh_token":"...","expiry":"..."}

[r2]
type = s3
provider = Cloudflare
access_key_id = <R2_ACCESS_KEY_ID>
secret_access_key = <R2_SECRET>
endpoint = https://<ACCOUNT_ID>.r2.cloudflarestorage.com
acl = private
no_check_bucket = true
```

> The workflow uses `rclone copy` (additive — never deletes). Switch to
> `rclone sync` for a true mirror only after it's proven solid, ideally with R2
> object versioning enabled as a safety net.

---

## Folder & naming conventions (the contract)

- Each subfolder under the bucket root = an **album**. Nesting → nested
  navigation (`2026 Competition/Nationals` → `#/2026-competition/nationals`).
- **Folder title:** folder name with `-`/`_` → spaces, Title-Cased, unless
  `album.json.title` overrides.
- **Item caption:** filename stem, de-slugged, unless overridden in `album.json`.
- **Album cover:** `album.json.cover` → else first image (alphabetical) → else
  first image in a child folder → else a fallback graphic.
- **Sort:** items by `order` then filename; albums by `album.json.order` then
  folder name **descending** (so `2026…` sorts above `2025…`).
- **Ignored:** anything named `album.json`, or starting with `_` or `.`.
- **Media types:** images `jpg jpeg png webp gif avif`; video `mp4 mov webm m4v`.
- **Video posters:** sibling image with the same stem (`solo.mp4` + `solo.jpg`),
  else `album.json.items["solo.mp4"].poster`. A sibling poster image is hidden
  from the tile grid so it shows only as the video's poster.
- **External embeds:** declared per folder in `album.json.embeds` (YouTube/Vimeo)
  so long-form video need not live in R2.

### Optional `album.json` (drop into any folder)

```json
{
  "title": "2026 Competition",
  "description": "Highlights from the 2026 season.",
  "cover": "nationals-leap.jpg",
  "order": 2026,
  "items": {
    "nationals-leap.jpg": { "caption": "Nationals — grand jeté", "category": "Contemporary", "order": 1 },
    "solo.mp4": { "caption": "Nationals solo", "poster": "solo-poster.jpg" }
  },
  "embeds": [
    { "title": "Nationals solo (full)", "provider": "youtube", "id": "VIDEO_ID" }
  ]
}
```

All fields optional. No `album.json` = pure auto behavior.

---

## Caching & refresh

- Worker JSON responses are **edge-cached for 5 minutes** (`Cache-Control:
  public, max-age=300` + `caches.default`).
- **Refresh mechanism (chosen):** the sync workflow optionally calls
  Cloudflare's cache-purge API at the end of each run so new media appears
  immediately instead of waiting out the TTL. It's enabled by adding the repo
  secrets **`CF_API_TOKEN`** and **`CF_ZONE_ID`**; if those are absent the purge
  step is skipped and content simply appears within the 5-minute TTL.

---

## Acceptance criteria → where it's handled

1. Drop a file in Dropbox → appears within one sync interval + TTL, no redeploy — `sync.yml` + Worker live listing.
2. Folder hierarchy reproduced with working breadcrumbs — Worker `breadcrumbs`/`folders`, `gallery.html` routing.
3. Deep links `#/<path>` + back/forward — hash routing in `gallery.html`.
4. Images load from custom domain, not `r2.dev`, not proxied — Worker returns `MEDIA_BASE` URLs only.
5. Video plays in lightbox; embeds render YouTube/Vimeo — lightbox `<video>`/iframe.
6. `album.json` overrides titles/cover/order/captions — Worker `listFolder`.
7. No database anywhere — R2 listing is the source of truth.
8. Edge-cached + documented refresh — see *Caching & refresh* above.
9. Existing design + interactions preserved — `gallery.html` reuses the site tokens; masonry, lightbox (keyboard + counter), Spotlight, reduced-motion.
10. `album.json`, dotfiles, `_`-prefixed files never shown — filtered in Worker.

## v2 (not built)

Thumbnails (`thumbUrl`), private/auth albums (Cloudflare Access), an admin
write-UI for `album.json`, and Dropbox-webhook-triggered instant sync.
