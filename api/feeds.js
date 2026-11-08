// GET /api/feeds — live feeds for executives.org.uk
// Fetches the feeds server-side (the browser cannot fetch RSS directly
// because of CORS) and returns one JSON document the homepage renders.
// No dependencies; Node 18+ global fetch. In-memory cache, 5 minutes,
// so a page reload does not hammer the sources.
//
// Sources (all verified live 2026-11-07):
//   news     BBC News RSS (AP News blocks server-side fetch with Cloudflare)
//   antiques GoAntiques homepage listings (eBay blocks server-side fetch)
//   estates  LandFlip land-for-sale listings (LandWatch blocks server-side
//            fetch with Akamai)
//   chefs    YouTube channels (RSS feed first, channel /videos page as
//            fallback — the RSS endpoint is unreliable). Channels: Paula
//            Deen, Gordon Ramsay, JunsKitchen, Just One Cookbook
//            (Cooking with Dog was swapped out: its newest video is about
//            a year old, archive only)
//   flights  OpenSky Network live aircraft states (free, no key) — live
//            flights in the air over the continental US, not charter
//            booking availability
//
// A feed that fails returns [] plus an entry in `errors`; the page shows
// that section as temporarily unavailable instead of inventing items.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const CACHE_MS = 5 * 60 * 1000;
let cache = { at: 0, data: null };

const CHANNELS = [
  { name: "Paula Deen", handle: "pauladeen", id: "UCr8xA60v_5j7n7TMPd8qmFw" },
  { name: "Gordon Ramsay", handle: "GordonRamsay", id: "UCIEv3lZ_tNXHzL3ox-_uUGQ" },
  { name: "JunsKitchen", handle: "junskitchen", id: "UCRxAgfYexGLlu1WHGIMUDqw" },
  { name: "Just One Cookbook", handle: "justonecookbook", id: "UCvBtKQaoDhsHkrvtLjSAhyw" },
];

function decodeEntities(s) {
  if (!s) return "";
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return ""; }
    })
    .replace(/\\"/g, '"')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return ""; }
    })
    .replace(/&#(\d+);/g, (_, n) => {
      try { return String.fromCodePoint(parseInt(n, 10)); } catch (e) { return ""; }
    })
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function cleanText(s) {
  return decodeEntities(String(s || ""))
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function relTime(iso) {
  const t = Date.parse(iso);
  if (isNaN(t)) return "Live";
  const mins = Math.max(0, Math.floor((Date.now() - t) / 60000));
  if (mins < 1) return "Just now";
  if (mins < 60) return mins + "m ago";
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + "h ago";
  const days = Math.floor(hours / 24);
  if (days < 30) return days + "d ago";
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

async function fetchText(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 9000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": UA, Accept: "text/html,application/xml,application/rss+xml,text/xml,*/*" },
    });
    if (!r.ok) throw new Error("HTTP " + r.status + " for " + url);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

function tagContent(block, tag) {
  const m = block.match(new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + tag + ">", "i"));
  if (!m) return "";
  let v = m[1].trim();
  if (v.indexOf("<![CDATA[") === 0) v = v.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
  return cleanText(v);
}

function parseRssItems(xml, limit) {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const b of blocks) {
    const title = tagContent(b, "title");
    const link = tagContent(b, "link");
    const desc = tagContent(b, "description");
    const pub = tagContent(b, "pubDate") || tagContent(b, "dc:date");
    if (title && link) items.push({ title, link, desc, pub });
    if (items.length >= limit) break;
  }
  return items;
}

function parseAtomEntries(xml, limit) {
  const out = [];
  const blocks = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks) {
    const title = tagContent(b, "title");
    const id = tagContent(b, "yt:videoId") || "";
    const published = tagContent(b, "published");
    const linkM = b.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/i) || b.match(/<link[^>]*href="([^"]+)"/i);
    const thumbM = b.match(/<media:thumbnail[^>]*url="([^"]+)"/i);
    if (title && id) {
      out.push({
        videoId: id,
        title,
        published,
        url: (linkM && linkM[1]) || ("https://www.youtube.com/watch?v=" + id),
        thumb: thumbM ? thumbM[1] : ("https://i.ytimg.com/vi/" + id + "/hqdefault.jpg"),
      });
    }
    if (out.length >= limit) break;
  }
  return out;
}

// ---- individual feeds ----

async function fetchNews() {
  const xml = await fetchText("https://feeds.bbci.co.uk/news/rss.xml", 9000);
  const items = parseRssItems(xml, 6);
  if (!items.length) throw new Error("BBC RSS returned no items");
  return items.map((it, i) => ({
    id: "N-" + (i + 1),
    title: it.title,
    time: relTime(it.pub),
    source: "BBC News",
    body: it.desc || it.title,
    url: it.link,
  }));
}

async function fetchAntiques() {
  const html = await fetchText("https://www.goantiques.com/", 9000);
  const blocks = html.split('<article class="listing">').slice(1, 7);
  const out = [];
  for (const b of blocks) {
    const hrefM = b.match(/<a href="([^"]+)"/i);
    const imgM = b.match(/data-src="(https:\/\/[^"]+)"/i) || b.match(/<img[^>]*src="(https:\/\/[^"]+)"/i);
    const descM = b.match(/<div class="description">([\s\S]*?)<\/div>/i);
    const priceM = b.match(/<div class="price">([^<]+)<\/div>/i);
    if (!hrefM || !descM || !priceM) continue;
    const title = cleanText(descM[1]).slice(0, 90);
    const price = cleanText(priceM[1]);
    if (!title || !price) continue;
    out.push({
      id: "A-" + (out.length + 1),
      title,
      price,
      img: imgM ? imgM[1] : "",
      time: "Live",
      source: "GoAntiques",
      bid: price,
      url: "https://www.goantiques.com" + hrefM[1],
    });
  }
  if (!out.length) throw new Error("GoAntiques returned no listings");
  return out;
}

async function fetchEstates() {
  // LandFlip rate-limits bursts on the search page (transient 403s that
  // clear after a short pause). Try the search page, then the homepage
  // (which carries the same listing cards), before giving up.
  const urls = [
    "https://www.landflip.com/land-for-sale",
    "https://www.landflip.com/",
  ];
  let lastErr = null;
  for (const url of urls) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const html = await fetchText(url, 12000);
        const estates = parseLandFlip(html);
        if (estates.length) return estates;
        lastErr = new Error("LandFlip returned no listings");
      } catch (e) {
        lastErr = e;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw lastErr || new Error("LandFlip failed");
}

function parseLandFlip(html) {
  const blocks = html.split("listing-card").slice(1, 7);
  const out = [];
  for (const b of blocks) {
    const acresM = b.match(/([\d.]+)\s*Acres?/i);
    const priceM = b.match(/<span[^>]*>\s*\$([\d,]+)\s*<\/span>/i);
    const linkM = b.match(/<a[^>]*href="(\/land\/[^"]+)"[^>]*>([^<]{5,140})<\/a>/i);
    const imgM = b.match(/<img[^>]*src="(https:\/\/cdn\.landflip\.com\/[^"]+_detail\.webp)"/i)
      || b.match(/srcSet="[^"]*(https:\/\/cdn\.landflip\.com\/[^"\s]+_detail\.webp)/i);
    const locM = b.match(/<\/h3>\s*<p[^>]*>([^<]{3,120})/i);
    if (!linkM || !priceM) continue;
    const acres = acresM ? acresM[1] : "";
    const loc = locM ? cleanText(locM[1]).replace(/,.*$/, "").trim() : "";
    out.push({
      id: "E-" + (out.length + 1),
      title: cleanText(linkM[2]).slice(0, 90),
      loc: loc || "United States",
      price: "$" + priceM[1],
      size: acres ? acres + " acres" : "",
      status: "Available",
      url: "https://www.landflip.com" + linkM[1],
      img: imgM ? imgM[1] : "",
    });
  }
  if (!out.length) throw new Error("LandFlip returned no listings");
  return out;
}

function parseYoutubePageVideos(html, limit) {
  const out = [];
  const parts = html.split('"lockupViewModel":').slice(1);
  for (const p of parts) {
    const cid = p.match(/"contentId":"([A-Za-z0-9_-]{11})"/);
    const title = p.match(/"title":\{"content":"((?:[^"\\]|\\.){3,160})"/);
    const date = p.match(/"content":"([^"]*(?:ago|Streamed)[^"]*)"/);
    if (!cid || !title) continue;
    const videoId = cid[1];
    if (out.some((v) => v.videoId === videoId)) continue;
    out.push({
      videoId,
      title: cleanText(title[1]),
      publishedText: date ? cleanText(date[1]) : "",
      url: "https://www.youtube.com/watch?v=" + videoId,
      thumb: "https://i.ytimg.com/vi/" + videoId + "/hqdefault.jpg",
    });
    if (out.length >= limit) break;
  }
  return out;
}

async function fetchChannelVideos(ch) {
  // Try the official channel RSS feed first (it is unreliable), then fall
  // back to parsing the channel's /videos page.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const xml = await fetchText(
        "https://www.youtube.com/feeds/videos.xml?channel_id=" + ch.id,
        8000
      );
      const entries = parseAtomEntries(xml, 2);
      if (entries.length) {
        return entries.map((e) => ({
          id: "V-" + e.videoId,
          title: e.title,
          channel: ch.name,
          videoId: e.videoId,
          url: e.url,
          thumb: e.thumb,
          published: e.published ? relTime(e.published) : "Live",
        }));
      }
    } catch (e) {
      // fall through to the page parse
    }
  }
  const html = await fetchText("https://www.youtube.com/@" + ch.handle + "/videos", 12000);
  const vids = parseYoutubePageVideos(html, 2);
  if (!vids.length) throw new Error("No videos found for " + ch.name);
  return vids.map((v) => ({
    id: "V-" + v.videoId,
    title: v.title,
    channel: ch.name,
    videoId: v.videoId,
    url: v.url,
    thumb: v.thumb,
    published: v.publishedText || "Live",
  }));
}

async function fetchChefs() {
  const results = await Promise.allSettled(CHANNELS.map((ch) => fetchChannelVideos(ch)));
  const out = [];
  for (const r of results) {
    if (r.status === "fulfilled") out.push(...r.value);
  }
  if (!out.length) throw new Error("No chef videos loaded");
  return out.slice(0, 8);
}

async function fetchFlights() {
  const data = JSON.parse(
    await fetchText(
      "https://opensky-network.org/api/states/all?lamin=24&lomin=-125&lamax=50&lomax=-66",
      10000
    )
  );
  const states = Array.isArray(data.states) ? data.states : [];
  const airborne = states
    .filter((st) => st && st[8] === false && st[1] && String(st[1]).trim())
    .map((st) => ({
      id: st[0],
      callsign: String(st[1]).trim(),
      country: st[2] || "",
      lat: st[6],
      lon: st[5],
      alt: st[7] != null ? Math.round(st[7] * 3.28084) : null,
      speed: st[9] != null ? Math.round(st[9] * 1.94384) : null,
      heading: st[10] != null ? Math.round(st[10]) : null,
    }))
    .sort((a, b) => (b.alt || 0) - (a.alt || 0))
    .slice(0, 8);
  if (!airborne.length) throw new Error("OpenSky returned no airborne flights");
  return airborne;
}

// ---- handler ----

async function buildFeeds() {
  const settled = await Promise.allSettled([
    fetchAntiques(),
    fetchNews(),
    fetchEstates(),
    fetchChefs(),
    fetchFlights(),
  ]);
  const keys = ["antiques", "news", "estates", "chefs", "flights"];
  const data = { updatedAt: new Date().toISOString(), errors: {} };
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") {
      data[keys[i]] = r.value;
      data.errors[keys[i]] = null;
    } else {
      data[keys[i]] = [];
      data.errors[keys[i]] = String((r.reason && r.reason.message) || r.reason || "failed");
    }
  });
  return data;
}

module.exports = async (req, res) => {
  try {
    if (cache.data && Date.now() - cache.at < CACHE_MS) {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
      return res.status(200).json(cache.data);
    }
    const data = await buildFeeds();
    cache = { at: Date.now(), data };
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: "feeds failed", message: String((e && e.message) || e) });
  }
};
