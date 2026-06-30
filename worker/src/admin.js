// Admin API (Cloudflare Worker module).
// Every request is gated by Cloudflare Access (the Access app sits in front of
// /admin* at the edge) AND independently re-verified here: the Access JWT is
// validated against the team JWKS, then the verified email is authorized
// against site/members.json. R2 write credentials never reach the browser.

const MAX_BODY = 256 * 1024; // 256 KB cap on any written JSON
const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif"]);
const VIDEO_EXT = new Set(["mp4", "mov", "webm", "m4v"]);
const META = new Set(["album.json"]);

// Keys the admin is allowed to write (plus any */album.json — see writeKeyOK).
const WRITABLE = new Set([
  "site/content.json",
  "site/links.json",
  "site/members.json",
]);

const json = (o, status = 200, extra = {}) =>
  new Response(JSON.stringify(o), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });

const titleize = (s) =>
  s
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
const extOf = (k) => (k.toLowerCase().match(/\.([a-z0-9]+)$/) || [, ""])[1];
const baseName = (k) => k.split("/").pop();
const stemOf = (b) => b.replace(/\.[^.]+$/, "");
const mediaUrl = (env, key) =>
  (env.MEDIA_BASE || "").replace(/\/$/, "") +
  "/" +
  key.split("/").map(encodeURIComponent).join("/");

// Mirror of the gallery's heuristic: only treat a filename as a readable title
// (otherwise leave the caption blank so junk names aren't auto-saved/shown).
function looksLikeTitle(stem) {
  const s = (stem || "").trim();
  if (!s) return false;
  if (/(^|[ _-])(img|dsc|dscf|mvi|mov|vid|pxl|gopr|dji|fullsizerender|untitled|export|final|render|seq|screenrecording|screenshot)([ _-]?\d|$)/i.test(s)) return false;
  if (/screen[ _-]?(recording|shot)/i.test(s)) return false;
  if (/(^|[ _-])(19|20)\d{2}([-_/. ]?\d{2}){2}([ _-]|$)/.test(s)) return false;
  if (/\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b/.test(s)) return false;
  if (!/\s/.test(s)) return false;
  if ((s.match(/[A-Za-z]{3,}/g) || []).length < 2) return false;
  const digits = (s.match(/\d/g) || []).length;
  const letters = (s.match(/[A-Za-z]/g) || []).length;
  if (digits >= letters) return false;
  return true;
}

function writeKeyOK(key) {
  if (key.includes("..")) return false;
  if (WRITABLE.has(key)) return true;
  return /^[^?]+\/album\.json$/.test(key);
}

/* ---------------- Access JWT verification (RS256 vs JWKS) ---------------- */

let jwksCache = { team: null, keys: null, exp: 0 };

function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64urlToString = (s) => new TextDecoder().decode(b64urlToBytes(s));

async function getJwks(env) {
  const team = env.ACCESS_TEAM;
  if (!team) return null;
  const now = Date.now();
  if (jwksCache.keys && jwksCache.team === team && jwksCache.exp > now) {
    return jwksCache.keys;
  }
  const res = await fetch(
    `https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`
  );
  if (!res.ok) return null;
  const data = await res.json();
  jwksCache = { team, keys: data.keys || [], exp: now + 60 * 60 * 1000 };
  return jwksCache.keys;
}

// Returns the verified email (string) or null.
async function accessEmail(req, env) {
  const jwt = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt) return null;
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;

  let header, payload;
  try {
    header = JSON.parse(b64urlToString(parts[0]));
    payload = JSON.parse(b64urlToString(parts[1]));
  } catch {
    return null;
  }
  if (header.alg !== "RS256") return null;

  // exp / iss / aud
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) return null;
  if (payload.nbf && payload.nbf > now + 60) return null;
  if (env.ACCESS_TEAM &&
      payload.iss !== `https://${env.ACCESS_TEAM}.cloudflareaccess.com`) {
    return null;
  }
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (env.ACCESS_AUD && !aud.includes(env.ACCESS_AUD)) return null;

  const keys = await getJwks(env);
  if (!keys) return null;
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;

  let key;
  try {
    key = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
  } catch {
    return null;
  }
  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const sig = b64urlToBytes(parts[2]);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    sig,
    data
  );
  if (!ok) return null;
  return (payload.email || "").toLowerCase() || null;
}

async function readJson(env, key, fallback = null) {
  const obj = await env.MEDIA.get(key);
  if (!obj) return fallback;
  try {
    return await obj.json();
  } catch {
    return fallback;
  }
}

async function getMember(env, email) {
  const data = await readJson(env, "site/members.json", { members: [] });
  const list = (data && data.members) || [];
  return (
    list.find(
      (m) =>
        (m.email || "").toLowerCase() === (email || "").toLowerCase() &&
        m.status === "active"
    ) || null
  );
}

/* ----------------------------- cache purge ----------------------------- */

async function purgeUrls(env, urls) {
  // Purge specific public file URLs from the Cloudflare CDN, if configured.
  if (!env.CF_PURGE_TOKEN || !env.CF_ZONE_ID || !urls.length) return;
  try {
    await fetch(
      `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/purge_cache`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.CF_PURGE_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ files: urls }),
      }
    );
  } catch {
    /* non-fatal: content still refreshes after TTL */
  }
}

async function purgeGalleryList(env, path) {
  // Drop the gallery /api/list cache entries for this folder (all origins).
  const cache = caches.default;
  const origins = (env.ALLOW_ORIGIN || "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  origins.push("*");
  const base = (env.SELF_BASE || env.SITE_API_BASE || "https://api.local")
    .replace(/\/$/, "");
  for (const o of origins) {
    const u = new URL(base + "/api/list");
    u.searchParams.set("path", path);
    u.searchParams.set("__o", o);
    try {
      await cache.delete(new Request(u.toString(), { method: "GET" }));
    } catch {
      /* best effort */
    }
  }
}

/* ----------------------------- body helpers ---------------------------- */

async function readBodyJson(req) {
  const text = await req.text();
  if (text.length > MAX_BODY) return { error: "body_too_large" };
  try {
    return { value: JSON.parse(text), text };
  } catch {
    return { error: "invalid_json" };
  }
}

async function writeJsonKey(env, key, obj) {
  const body = JSON.stringify(obj);
  await env.MEDIA.put(key, body, {
    httpMetadata: {
      contentType: "application/json",
      cacheControl: "public, max-age=60",
    },
  });
}

/* ----------------------------- album listing --------------------------- */

async function readAlbum(env, path) {
  const prefix = path ? path.replace(/\/+$/, "") + "/" : "";
  const res = await env.MEDIA.list({ prefix, delimiter: "/", limit: 1000 });
  const album = (await readJson(env, prefix + "album.json", {})) || {};

  const folders = res.delimitedPrefixes
    .map((p) => p.slice(prefix.length).replace(/\/$/, ""))
    .filter((n) => !n.startsWith("_") && !(prefix === "" && n === "site"))
    .map((n) => ({ name: n, path: (prefix + n).replace(/\/$/, "") }));

  const objs = res.objects;
  const videoStems = new Set();
  for (const o of objs) {
    const bn = baseName(o.key);
    if (VIDEO_EXT.has(extOf(bn))) videoStems.add(stemOf(bn));
  }

  const items = [];
  for (const o of objs) {
    const bn = baseName(o.key);
    if (META.has(bn) || bn.startsWith(".")) continue;
    const e = extOf(bn);
    const type = VIDEO_EXT.has(e) ? "video" : IMAGE_EXT.has(e) ? "image" : null;
    if (!type) continue;
    // Skip images acting only as a video poster (same stem as a video).
    if (type === "image" && videoStems.has(stemOf(bn))) continue;
    const meta = (album.items && album.items[bn]) || {};
    items.push({
      file: bn,
      key: o.key,
      url: mediaUrl(env, o.key),
      type,
      caption: meta.caption || (looksLikeTitle(stemOf(bn)) ? titleize(stemOf(bn)) : ""),
      category: meta.category || null,
      order: meta.order ?? null,
      hidden: meta.hidden === true,
      size: o.size,
    });
  }
  items.sort(
    (a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.file.localeCompare(b.file)
  );

  return {
    path: prefix.replace(/\/$/, ""),
    album: {
      title: album.title || null,
      description: album.description || null,
      cover: album.cover || null,
      order: album.order ?? null,
      embeds: album.embeds || [],
    },
    folders,
    items,
  };
}

/* ------------------------------- router -------------------------------- */

export async function handleAdmin(req, env, ctx, url) {
  const p = url.pathname;
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  // 1) Identity (Access JWT) — 401 if absent/invalid.
  const email = await accessEmail(req, env);
  if (!email) return json({ error: "unauthorized" }, 401);

  // 2) Authorization (members.json) — 403 if not an active member.
  const member = await getMember(env, email);
  if (!member) return json({ error: "forbidden" }, 403);
  const isOwner = member.role === "owner";
  const canEdit = isOwner || member.role === "editor";
  const me = { email: member.email, name: member.name, role: member.role };

  // GET /admin/me
  if (req.method === "GET" && p === "/admin/me") return json(me);

  // GET/PUT /admin/content
  if (p === "/admin/content") {
    if (req.method === "GET") {
      return json(await readJson(env, "site/content.json", {}));
    }
    if (req.method === "PUT") {
      if (!canEdit) return json({ error: "forbidden" }, 403);
      const b = await readBodyJson(req);
      if (b.error) return json({ error: b.error }, 400);
      if (typeof b.value !== "object" || Array.isArray(b.value))
        return json({ error: "invalid_shape" }, 400);
      await writeJsonKey(env, "site/content.json", b.value);
      ctx.waitUntil(purgeUrls(env, [mediaUrl(env, "site/content.json")]));
      return json({ ok: true, content: b.value });
    }
  }

  // GET/PUT /admin/links
  if (p === "/admin/links") {
    if (req.method === "GET") {
      return json(await readJson(env, "site/links.json", { links: [], downloads: [] }));
    }
    if (req.method === "PUT") {
      if (!canEdit) return json({ error: "forbidden" }, 403);
      const b = await readBodyJson(req);
      if (b.error) return json({ error: b.error }, 400);
      if (typeof b.value !== "object" || Array.isArray(b.value))
        return json({ error: "invalid_shape" }, 400);
      await writeJsonKey(env, "site/links.json", b.value);
      ctx.waitUntil(purgeUrls(env, [mediaUrl(env, "site/links.json")]));
      return json({ ok: true, links: b.value });
    }
  }

  // GET /admin/site-images — files currently in _Site/ (for slot pickers)
  if (req.method === "GET" && p === "/admin/site-images") {
    const res = await env.MEDIA.list({ prefix: "_Site/", delimiter: "/", limit: 1000 });
    const files = res.objects
      .map((o) => o.key)
      .filter((k) => {
        const bn = baseName(k);
        return !k.endsWith("/") && !bn.startsWith(".") && IMAGE_EXT.has(extOf(bn));
      })
      .map((k) => ({ key: k, url: mediaUrl(env, k) }));
    return json({ files });
  }

  // GET/PUT /admin/album?path=
  if (p === "/admin/album") {
    const path = (url.searchParams.get("path") || "")
      .replace(/^\/+/, "")
      .replace(/\.\./g, "")
      .replace(/\/+$/, "");
    if (req.method === "GET") {
      return json(await readAlbum(env, path));
    }
    if (req.method === "PUT") {
      if (!canEdit) return json({ error: "forbidden" }, 403);
      const key = (path ? path + "/" : "") + "album.json";
      if (!writeKeyOK(key)) return json({ error: "bad_path" }, 400);
      const b = await readBodyJson(req);
      if (b.error) return json({ error: b.error }, 400);
      if (typeof b.value !== "object" || Array.isArray(b.value))
        return json({ error: "invalid_shape" }, 400);
      await writeJsonKey(env, key, b.value);
      ctx.waitUntil(
        Promise.all([
          purgeUrls(env, [mediaUrl(env, key)]),
          purgeGalleryList(env, path),
        ])
      );
      return json({ ok: true, album: b.value });
    }
  }

  // GET/PUT /admin/members  (owner only)
  if (p === "/admin/members") {
    if (!isOwner) return json({ error: "forbidden" }, 403);
    if (req.method === "GET") {
      return json(await readJson(env, "site/members.json", { members: [] }));
    }
    if (req.method === "PUT") {
      const b = await readBodyJson(req);
      if (b.error) return json({ error: b.error }, 400);
      const next = b.value && Array.isArray(b.value.members) ? b.value.members : null;
      if (!next) return json({ error: "invalid_shape" }, 400);

      // Normalize + validate entries.
      const seen = new Set();
      for (const m of next) {
        if (!m || typeof m.email !== "string" || !m.email.includes("@"))
          return json({ error: "invalid_member" }, 400);
        m.email = m.email.toLowerCase();
        if (seen.has(m.email)) return json({ error: "duplicate_email" }, 400);
        seen.add(m.email);
        if (!["owner", "editor"].includes(m.role))
          return json({ error: "invalid_role" }, 400);
        if (!["active", "inactive"].includes(m.status)) m.status = "active";
      }

      // Safeguard: at least one active owner must remain.
      if (!next.some((m) => m.role === "owner" && m.status === "active"))
        return json({ error: "need_active_owner" }, 400);

      // Safeguard: you cannot change or deactivate your own role.
      const selfNew = next.find((m) => m.email === email);
      if (!selfNew || selfNew.role !== member.role || selfNew.status !== "active")
        return json({ error: "cannot_change_self" }, 400);

      await writeJsonKey(env, "site/members.json", { members: next });
      return json({ ok: true, members: next });
    }
  }

  // POST /admin/purge  { paths?: [galleryPaths], urls?: [fileUrls] }
  if (req.method === "POST" && p === "/admin/purge") {
    if (!canEdit) return json({ error: "forbidden" }, 403);
    const b = await readBodyJson(req);
    if (b.error) return json({ error: b.error }, 400);
    const urls = Array.isArray(b.value.urls) ? b.value.urls : [];
    const paths = Array.isArray(b.value.paths) ? b.value.paths : [];
    ctx.waitUntil(
      Promise.all([
        purgeUrls(env, urls),
        ...paths.map((pp) => purgeGalleryList(env, String(pp))),
      ])
    );
    return json({ ok: true });
  }

  return json({ error: "not_found" }, 404);
}
