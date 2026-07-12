# Admin Panel

A private, authenticated dashboard to edit site content, swap curated site
images, and manage gallery metadata — no code, no redeploys. Builds on the
existing gallery + Dropbox→R2 sync (see `GALLERY.md`).

## How it's wired

```
Member browser
   │  signs in via Cloudflare Access (email one-time code) — gates /admin*
   ▼
api.breakthestageboy.com
   ├─ GET /admin            → admin SPA (static asset, served by the Worker)
   ├─ /admin/<resource>     → admin API (verifies Access JWT + members.json role)
   └─ GET /api/list         → public gallery API (open, unchanged)
        │  R2 binding (server-only; write keys never reach the browser)
        ▼
R2 bucket gavin-media
   site/content.json  site/links.json  site/members.json   ← admin-written (R2 only)
   _Site/hero.jpg …                                         ← curated images (from Dropbox)
   <album>/album.json                                       ← admin-written (R2 only)
```

**Design choice:** the admin SPA is served **by the Worker** at `/admin` (not
Render), so the SPA and its API are **same-origin** behind **one** Access
application — no cross-site cookie/CORS complexity. The public site and gallery
are untouched and stay open.

The public homepage now reads `site/content.json` and `site/links.json` at load
(progressive enhancement): any field present overrides the built-in copy; if the
files are absent or unreachable, the page shows its original hardcoded content,
so it can never break.

---

## One-time setup

### 1. Deploy the updated Worker

```bash
cd worker
git pull origin main
npm install
npx wrangler deploy        # uploads worker + the admin SPA static asset
```

### 2. Create the Cloudflare Access application

Cloudflare dashboard → **Zero Trust** → **Access** → **Applications** → **Add an
application** → **Self-hosted**:

- **Application name:** `Gavin Howell Admin`
- **Session duration:** your choice (e.g. 24h)
- **Public hostname:** `api.breakthestageboy.com` with **Path** = `admin` (so it
  protects `/admin*` and leaves `/api/*` public). Add `admin/*` too if the UI
  asks for an explicit wildcard.
- **Identity / login method:** enable **One-time PIN** (email code) and/or Google.
- **Policy:** Action **Allow**, include the emails you'll invite (at minimum your
  owner email). `site/members.json` is still the authoritative app gate, but
  scoping the Access policy adds defense-in-depth.

After creating it, open the application's settings and copy:
- the **Application Audience (AUD) tag** → this is `ACCESS_AUD`
- your **team name** (the `<team>` in `https://<team>.cloudflareaccess.com`) → `ACCESS_TEAM`

### 3. Configure Worker vars + secrets

In `worker/wrangler.toml`, set `ACCESS_TEAM` to your real team name (and
`CF_ZONE_ID` if you want targeted cache purges). Then set the secrets:

```bash
cd worker
npx wrangler secret put ACCESS_AUD       # paste the AUD tag
# optional, for instant cache purges after edits:
npx wrangler secret put CF_PURGE_TOKEN   # a token with Zone → Cache Purge
npx wrangler deploy
```

### 4. Seed the owner into `site/members.json`

Edit `worker/seed/members.json` so the `email` is the address **you will sign in
with** (the example uses `chadhowell11@gmail.com`). Then upload it to R2:

```bash
cd worker
npx wrangler r2 object put gavin-media/site/members.json --file=seed/members.json --content-type=application/json
```

(R2 object commands target the remote bucket by default — there is no
`--remote` flag; use `--local` only if you want the local dev store.)

This bootstraps the first owner. From then on, add/remove members in the panel.

### 5. Curated site images (`_Site/`)

In Dropbox, inside your sync folder `Gavin Howell/Dance/BTSB-WEBSITE-GALLERY`,
create a folder named **`_Site`** and drop in the designed-in photos:

| Slot | Filename | Size |
|---|---|---|
| Hero | `hero.jpg` | ~1600×1200 landscape |
| About portrait | `about-portrait.jpg` | ~1000×1400 portrait |
| Journey | `journey.jpg` | ~1000×1400 portrait |
| Social share | `og.jpg` | exactly 1200×630 |

They sync to R2 like everything else. `_Site/` is hidden from the public gallery
(folders starting with `_` are skipped). Pick which file fills each slot on the
**Site images** screen.

### Managing the home-page photo grids

The two home-page photo grids — **In motion & in frame** and **Curated
highlights** — are also managed from `_Site/` on the **Site images** screen,
below the single-image slots above.

1. Drop the photos into the **`_Site`** folder in Dropbox (directly in `_Site/`,
   not a subfolder) and wait for the next sync.
2. On **Site images**, each grid has its own list. Click **+ Add**, choose a
   photo from the `_Site/` dropdown, and repeat for each image. Use **↑ / ↓** to
   set the order they appear in.
3. **Save image choices.** Allow a few minutes for the CDN cache, or use
   **Refresh site images cache**.

Notes:
- No cropping or fixed sizes to worry about — the grids use a masonry layout, so
  portrait, landscape, and square photos all display in full at their natural
  aspect ratio. Add as many images as you like.
- A grid **hides itself** when it has no images, so an unconfigured section never
  shows an empty box.
- These lists are stored in `site/content.json` under `images.motion` and
  `images.highlights` (ordered arrays of `_Site/` keys).

### 6. Test

Visit **https://api.breakthestageboy.com/admin** → Cloudflare prompts you to sign
in → you land on the dashboard with your role. Try editing a field in **Site
content**, save, and refresh the homepage.

### Syncing new media sooner

The Dropbox→R2 sync runs on a GitHub Actions schedule, but GitHub treats
schedules as best-effort and often throttles them to roughly hourly — so new
uploads can take a while to appear.

To pull new media **now**, run the workflow manually:

- The admin dashboard has a **⟳ Sync from Dropbox ↗** link that opens the
  workflow in a new tab. On that page, click **Run workflow** (branch `main`).
- Direct link:
  https://github.com/chadhowell11/Gavin-Howell/actions/workflows/sync.yml

It finishes in about a minute; allow a couple more for the CDN cache (or it
clears automatically).

---

## Roles

- **owner** — everything, including Members.
- **editor** — site content, images, and gallery metadata; cannot manage members.

Safeguards (enforced server-side): always ≥1 active owner; you can't change or
deactivate your own role; email is the unique key.

## Security notes (how the requirements are met)

- All `/admin*` requests sit behind Cloudflare Access; the Worker independently
  re-verifies the Access JWT (RS256 against the team JWKS, checking `aud`, `iss`,
  `exp`) on **every** request.
- Authorization is checked server-side per request via `members.json` + role.
- R2 write access exists only in the Worker; no write keys reach the browser.
- Writes are allow-listed to `site/content.json`, `site/links.json`,
  `site/members.json`, and `*/album.json`; traversal (`..`) and any other key are
  rejected. Bodies are size-capped (256 KB) and JSON-validated.
- The panel never uploads media — it directs you to Dropbox for adding files.

## Companion changes already shipped

- Gallery Worker hides folders whose name starts with `_` (so `_Site/` never
  shows as an album) and skips items marked `hidden: true` in `album.json`.
- The homepage reads `content.json` / `links.json` / `_Site` images at runtime.

## v2 (not built)

In-app Access-policy management, content version history, direct upload from the
panel, and an audit log.
