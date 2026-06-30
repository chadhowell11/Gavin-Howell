// Folder-driven gallery API + admin router (Cloudflare Worker).
// - GET /api/list      → public gallery listing (open, CDN-cached)
// - /admin/<resource>  → authenticated admin API (see admin.js)
// - everything else     → static assets (the admin SPA page)
// Media bytes are never proxied through the Worker — only URLs that point at
// the custom domain (MEDIA_BASE) are returned, so images stay CDN-cached.

import { handleAdmin } from "./admin.js";

const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif"]);
const VIDEO_EXT = new Set(["mp4", "mov", "webm", "m4v"]);
const META = new Set(["album.json"]);

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
  env.MEDIA_BASE.replace(/\/$/, "") +
  "/" +
  key.split("/").map(encodeURIComponent).join("/");

// Heuristic: does a filename stem look like a human-set, readable title (so we
// show it as a caption), versus a system/camera name (IMG_1234, 240B, dates,
// ScreenRecording…, which we hide)? Admin-set album.json captions always show.
function looksLikeTitle(stem) {
  const s = (stem || "").trim();
  if (!s) return false;
  // camera / screen-capture / generic export names
  if (/(^|[ _-])(img|dsc|dscf|mvi|mov|vid|pxl|gopr|dji|fullsizerender|untitled|export|final|render|seq|screenrecording|screenshot)([ _-]?\d|$)/i.test(s)) return false;
  if (/screen[ _-]?(recording|shot)/i.test(s)) return false;
  // date stamps (2026-06-30, 05-16-2026, 20260630…)
  if (/(^|[ _-])(19|20)\d{2}([-_/. ]?\d{2}){2}([ _-]|$)/.test(s)) return false;
  if (/\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b/.test(s)) return false;
  // human titles use spaces between words…
  if (!/\s/.test(s)) return false;
  // …with at least two real words…
  if ((s.match(/[A-Za-z]{3,}/g) || []).length < 2) return false;
  // …and aren't dominated by digits
  const digits = (s.match(/\d/g) || []).length;
  const letters = (s.match(/[A-Za-z]/g) || []).length;
  if (digits >= letters) return false;
  return true;
}

async function readJson(env, key) {
  const obj = await env.MEDIA.get(key);
  if (!obj) return null;
  try {
    return await obj.json();
  } catch {
    return null;
  }
}

// List every object/prefix under `prefix` at this level, following cursors so
// folders with >1000 keys are handled correctly.
async function listAll(env, prefix, delimiter) {
  const objects = [];
  const delimitedPrefixes = [];
  let cursor;
  do {
    const res = await env.MEDIA.list({
      prefix,
      delimiter,
      limit: 1000,
      cursor,
    });
    objects.push(...res.objects);
    if (res.delimitedPrefixes) delimitedPrefixes.push(...res.delimitedPrefixes);
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);
  return { objects, delimitedPrefixes };
}

async function listFolder(env, prefix) {
  const res = await listAll(env, prefix, "/");
  const album = (await readJson(env, prefix + "album.json")) || {};

  // Subfolders -> nested albums
  const folders = [];
  for (const p of res.delimitedPrefixes) {
    const name = p.slice(prefix.length).replace(/\/$/, "");
    // Hide utility folders: _-prefixed (e.g. _Site images) and the admin
    // data prefix `site/` (content.json, links.json, members.json).
    if (name.startsWith("_") || (prefix === "" && name === "site")) continue;
    const sub = await env.MEDIA.list({ prefix: p, limit: 1000 });
    // Stems of videos in this folder, so a video's poster image isn't counted
    // as a separate photo.
    const vidStems = new Set();
    for (const o of sub.objects) {
      if (VIDEO_EXT.has(extOf(o.key))) vidStems.add(stemOf(baseName(o.key)));
    }
    let cover = null,
      images = 0,
      videos = 0;
    for (const o of sub.objects) {
      const bn = baseName(o.key);
      if (META.has(bn) || bn.startsWith("_") || bn.startsWith(".")) continue;
      const e = extOf(bn);
      if (VIDEO_EXT.has(e)) {
        videos++;
      } else if (IMAGE_EXT.has(e)) {
        if (!cover) cover = o.key; // any image (incl. a poster) can be the cover
        if (!vidStems.has(stemOf(bn))) images++; // but posters aren't counted
      }
    }
    const count = images + videos;
    const subAlbum = await readJson(env, p + "album.json");
    folders.push({
      name,
      path: p.replace(/\/$/, ""),
      title: (subAlbum && subAlbum.title) || titleize(name),
      images,
      videos,
      cover: subAlbum && subAlbum.cover
        ? mediaUrl(env, p + subAlbum.cover)
        : cover
        ? mediaUrl(env, cover)
        : null,
      order: subAlbum && subAlbum.order != null ? subAlbum.order : null,
      count,
    });
  }
  folders.sort(
    (a, b) =>
      (b.order ?? -Infinity) - (a.order ?? -Infinity) ||
      b.name.localeCompare(a.name)
  );

  // Items at this level
  const objs = res.objects;
  const items = [];
  for (const o of objs) {
    const bn = baseName(o.key);
    if (META.has(bn) || bn.startsWith("_") || bn.startsWith(".")) continue;
    const e = extOf(o.key);
    const type = VIDEO_EXT.has(e) ? "video" : IMAGE_EXT.has(e) ? "image" : null;
    if (!type) continue;
    const meta = (album.items && album.items[bn]) || {};
    if (meta.hidden === true) continue; // admin "hide" toggle
    let poster = null;
    if (type === "video") {
      const stem = stemOf(bn);
      const sib = objs.find((x) => {
        const b = baseName(x.key);
        return b !== bn && stemOf(b) === stem && IMAGE_EXT.has(extOf(b));
      });
      if (sib) poster = mediaUrl(env, sib.key);
      else if (meta.poster) poster = mediaUrl(env, prefix + meta.poster);
    }
    items.push({
      key: o.key,
      url: mediaUrl(env, o.key),
      type,
      caption: meta.caption || (looksLikeTitle(stemOf(bn)) ? titleize(stemOf(bn)) : null),
      category: meta.category || null,
      order: meta.order ?? null,
      poster,
      size: o.size,
    });
  }
  // Hide images that are only acting as a video poster (same stem as a video).
  const videoStems = new Set(
    items.filter((i) => i.type === "video").map((i) => stemOf(baseName(i.key)))
  );
  const visible = items.filter(
    (i) => !(i.type === "image" && videoStems.has(stemOf(baseName(i.key))))
  );
  visible.sort(
    (a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.key.localeCompare(b.key)
  );

  // Breadcrumbs
  const parts = prefix.replace(/\/$/, "").split("/").filter(Boolean);
  const breadcrumbs = [{ name: "Gallery", path: "" }];
  let acc = "";
  for (const part of parts) {
    acc += (acc ? "/" : "") + part;
    breadcrumbs.push({ name: titleize(part), path: acc });
  }

  return {
    path: prefix.replace(/\/$/, ""),
    title: album.title || (parts.length ? titleize(parts[parts.length - 1]) : "Gallery"),
    description: album.description || null,
    breadcrumbs,
    folders,
    items: visible,
    embeds: album.embeds || [],
  };
}

// Resolve the CORS Access-Control-Allow-Origin for a request. ALLOW_ORIGIN may
// be a comma-separated list (e.g. www + apex); echo back whichever made the
// request so CORS passes for all of them.
export function resolveOrigin(req, env) {
  const reqOrigin = req.headers.get("Origin") || "";
  const allowList = (env.ALLOW_ORIGIN || "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowList.includes("*")) return "*";
  return allowList.includes(reqOrigin) ? reqOrigin : allowList[0] || "*";
}

// Public read of an admin-managed JSON file (content/links) with CORS headers,
// so the homepage on www can fetch it cross-origin (R2's media domain doesn't
// send CORS headers, which would otherwise block the fetch).
async function handlePublicJson(req, env, key) {
  const allowOrigin = resolveOrigin(req, env);
  const cors = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const obj = await env.MEDIA.get(key);
  const body = obj ? await obj.text() : "{}";
  return new Response(body, {
    headers: {
      ...cors,
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=30",
    },
  });
}

async function handleGalleryList(req, env, ctx, url) {
  const allowOrigin = resolveOrigin(req, env);
  const cors = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  const cache = caches.default;
  // Key the cache by resolved origin so a cached apex response is never served
  // to a www request (which would carry the wrong CORS header).
  const cacheUrl = new URL(url.toString());
  cacheUrl.searchParams.set("__o", allowOrigin);
  const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  let path = (url.searchParams.get("path") || "")
    .replace(/^\/+/, "")
    .replace(/\.\./g, "");
  if (path && !path.endsWith("/")) path += "/";

  try {
    const data = await listFolder(env, path);
    const res = new Response(JSON.stringify(data), {
      headers: {
        ...cors,
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
      },
    });
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  } catch (err) {
    return new Response(JSON.stringify({ error: "list_failed" }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;

    // Admin API lives under /admin/<resource>. The bare /admin and /admin/
    // paths are the SPA page and fall through to static assets.
    if (p.startsWith("/admin/") && p !== "/admin/") {
      return handleAdmin(req, env, ctx, url);
    }

    // Public gallery listing (open, no auth).
    if (p === "/api/list") {
      return handleGalleryList(req, env, ctx, url);
    }

    // Public, CORS-enabled reads of the site content/links JSON (for the homepage).
    if (p === "/api/content") return handlePublicJson(req, env, "site/content.json");
    if (p === "/api/links") return handlePublicJson(req, env, "site/links.json");

    // Everything else (the admin SPA page, favicon, etc.) is a static asset.
    if (env.ASSETS) return env.ASSETS.fetch(req);
    return new Response("Not found", { status: 404 });
  },
};
