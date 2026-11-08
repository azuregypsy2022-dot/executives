// GET /api/feeds — live feeds for executives.org.uk
// Fetches the feeds server-side (the browser cannot fetch RSS directly
// because of CORS) and returns one JSON document the homepage renders.
// No dependencies; Node 18+ global fetch. In-memory cache, 5 minutes,
// so a page reload does not hammer the sources.
//
// Sources (all verified live 2026-11-07):
//   news     BBC News RSS (AP News blocks server-side fetch with Cloudflare)
//   antiques GoAntiques homepage listings (eBay blocks server-side fetch)
//   estates  LandHub first, then LandCentury, Mossy Oak Properties,
//            then LandFlip last (LandWatch blocks server-side fetch
//            with Akamai; LandFlip 403s server-side fetches from every
//            IP tested; LandHub parses cleanly from a normal IP but
//            Vercel's egress addresses got nothing from it on Nov 8).
//            Last-good: on a fresh-fetch failure the last successful
//            result is served with its age instead of an empty list.
//   chefs    YouTube channels (RSS feed first, channel /videos page as
//            fallback — the RSS endpoint is unreliable). Channels: Paula
//            Deen, Gordon Ramsay, JunsKitchen, Just One Cookbook
//            (Cooking with Dog was swapped out: its newest video is about
//            a year old, archive only)
//   flights  adsb.lol live aircraft states (free, no key) — live
//            flights in the air over the continental US, not charter
//            booking availability. 25s timeout; OpenSky is now only
//            the fallback (15s, small box): it never completes from
//            Vercel's serverless runtime even with a 25s timeout.
//            Last-good fallback, same as estates.
//
// A feed that fails with no last-good data returns [] plus an entry in
// `errors`; the page shows that section as temporarily unavailable
// instead of inventing items. A feed served from last-good data
// carries `stale: { label, fetchedAt }` so the page can say how old
// the items are.

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
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xml,application/rss+xml,text/xml,*/*",
        "Accept-Language": "en-US,en;q=0.9",
      },
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
  // LandFlip returns 403 to server-side fetches from every IP we can
  // test from (this VM and Vercel), so it goes last now. LandHub is
  // first — it parses cleanly from a normal IP, but Vercel's egress
  // addresses got nothing from it on Nov 8, so LandCentury and Mossy
  // Oak Properties (both return 200 with parseable listings) follow
  // before LandFlip gets its one last try. Any source that returns
  // real listings wins immediately.
  const tries = [
    { url: "https://www.landhub.com/property-for-sale", ms: 12000, parse: parseLandHub, name: "LandHub" },
    { url: "https://www.landcentury.com/land-for-sale", ms: 12000, parse: parseLandCentury, name: "LandCentury" },
    { url: "https://www.mossyoakproperties.com/land-for-sale/", ms: 12000, parse: parseMossyOak, name: "Mossy Oak" },
    { url: "https://www.landflip.com/land-for-sale", ms: 8000, parse: parseLandFlip, name: "LandFlip" },
    { url: "https://www.landflip.com/", ms: 8000, parse: parseLandFlip, name: "LandFlip" },
  ];
  let lastErr = null;
  for (let i = 0; i < tries.length; i++) {
    try {
      const html = await fetchText(tries[i].url, tries[i].ms);
      const estates = tries[i].parse(html);
      if (estates.length) return estates;
      lastErr = new Error(tries[i].name + " returned no listings");
    } catch (e) {
      lastErr = e;
    }
    if (i < tries.length - 1) await new Promise((r) => setTimeout(r, 1000));
  }
  throw lastErr || new Error("No estate source returned listings");
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

function parseLandHub(html) {
  // LandHub (landhub.com) search page: each listing appears as a
  // /property/<slug> link; the card's <img alt> carries "#ID <title>
  // $<price>" and the card body carries county, acres and a photo.
  const out = [];
  const seen = new Set();
  const linkRe = /href="(\/property\/[^"]+)"/gi;
  let m;
  while ((m = linkRe.exec(html)) && out.length < 6) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    const win = html.slice(m.index, m.index + 4500);
    const altM = win.match(/<img[^>]*alt="([^"]+)"/i);
    const priceM = win.match(/\$[\d,]+(?:\.\d{2})?/);
    if (!altM || !priceM) continue;
    const title = cleanText(altM[1])
      .replace(/^#\S+\s+/, "")
      .replace(/\s*\$[\d,]+(?:\.\d{2})?$/, "")
      .trim();
    if (!title) continue;
    const price = priceM[0].replace(/\.00$/, "");
    const acresM = win.match(/([\d.]+)\s*Acres?/i);
    const countyM = win.match(/([A-Z][A-Za-z]*(?: [A-Z][A-Za-z]*)* County)/);
    const imgM = win.match(/\/_next\/image\?url=(https%3A%2F%2Fimg\.landhub\.com[^"&]+)/i);
    let img = "";
    if (imgM) {
      try { img = decodeURIComponent(imgM[1]); } catch (e) { img = ""; }
    }
    out.push({
      id: "E-" + (out.length + 1),
      title: title.slice(0, 90),
      loc: countyM ? cleanText(countyM[1]).trim() : "United States",
      price,
      size: acresM ? (acresM[1] === "1" ? "1 acre" : acresM[1] + " acres") : "",
      status: "Available",
      url: "https://www.landhub.com" + slug,
      img,
    });
  }
  if (!out.length) throw new Error("LandHub returned no listings");
  return out;
}

function parseLandCentury(html) {
  // LandCentury (Next.js): each listing is an <a class="...listing-card_card__...">
  // to /land-for-sale/<state>/<slug>; the card carries a price span, a
  // facts line ("4.91 acres · $2,536/acre"), a place line with county,
  // and an <img alt> with the full title ("... - $8,500 | Owner Financing").
  const out = [];
  const seen = new Set();
  const linkRe = /<a[^>]*class="[^"]*listing-card_card__[^"]*"[^>]*href="(\/land-for-sale\/[^"]+)"/gi;
  let m;
  while ((m = linkRe.exec(html)) && out.length < 6) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    const win = html.slice(m.index, m.index + 6000);
    const priceM = win.match(/listing-card_price__[A-Za-z0-9_-]*">(\$[\d,]+)/);
    const altM = win.match(/<img[^>]*alt="([^"]+)"/i);
    const factsM = win.match(/listing-card_facts__[A-Za-z0-9_-]*">([^<]+)</);
    const countyM = win.match(/listing-card_county__[A-Za-z0-9_-]*">([^<]+)</);
    const placeM = win.match(/listing-card_place__[A-Za-z0-9_-]*"><span>([^<]+)</);
    const imgM = win.match(/\/_next\/image\?url=(https%3A%2F%2F[^"&]+)/i);
    if (!priceM || !altM) continue;
    const title = cleanText(altM[1])
      .replace(/\s*-\s*\$[\d,]+.*$/, "")
      .replace(/\s*\|\s*Owner Financing\s*$/i, "")
      .trim();
    if (!title) continue;
    const acresM = factsM ? factsM[1].match(/([\d.]+)\s*acres?/i) : null;
    let img = "";
    if (imgM) {
      try { img = decodeURIComponent(imgM[1]); } catch (e) { img = ""; }
    }
    out.push({
      id: "E-" + (out.length + 1),
      title: title.slice(0, 90),
      loc: countyM
        ? cleanText(countyM[1]).trim()
        : (placeM ? cleanText(placeM[1]).replace(/\s*\d{5}\s*$/, "").trim() : "United States"),
      price: priceM[1],
      size: acresM ? (acresM[1] === "1" ? "1 acre" : acresM[1] + " acres") : "",
      status: "Available",
      url: "https://www.landcentury.com" + slug,
      img,
    });
  }
  if (!out.length) throw new Error("LandCentury returned no listings");
  return out;
}

function parseMossyOak(html) {
  // Mossy Oak Properties: each listing is a <div class="rs-listing-card
  // rs-listing-item"> with a card-title anchor (href + title), location
  // spans, a "3,239± Acres" label, a price label, and an <img> (RealStack CDN).
  const out = [];
  const blocks = html.split("rs-listing-card rs-listing-item").slice(1, 7);
  for (const b of blocks) {
    const titleM = b.match(/card-title">\s*<a[^>]*href="(https:\/\/www\.mossyoakproperties\.com\/property\/[^"]+)"[^>]*>([^<]{5,200})<\/a>/i);
    const acresM = b.match(/label--acre">([\d,]+)±?\s*Acres?/i);
    const priceM = b.match(/label--price">(\$[\d,]+)/i);
    const locM = b.match(/<div class="location">\s*<span>\s*([^<,]+),?\s*<\/span>\s*<span>([A-Z]{2})<\/span>/i);
    const imgM = b.match(/<img[^>]*src="(https:\/\/images\.realstack\.com[^"]+\.(?:jpg|jpeg|webp))"/i)
      || b.match(/data-src="(https:\/\/images\.realstack\.com[^"]+\.(?:jpg|jpeg|webp))"/i);
    if (!titleM || !priceM) continue;
    out.push({
      id: "E-" + (out.length + 1),
      title: cleanText(titleM[2]).slice(0, 90),
      loc: locM ? (cleanText(locM[1]).trim() + ", " + locM[2]) : "United States",
      price: priceM[1],
      size: acresM ? acresM[1].replace(/,/g, "") + " acres" : "",
      status: "Available",
      url: titleM[1],
      img: imgM ? imgM[1] : "",
    });
  }
  if (!out.length) throw new Error("Mossy Oak returned no listings");
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
  // adsb.lol is the primary source now: free, no key, answers in ~2s
  // from this VM (verified 2026-11-08: 4,600+ aircraft, ~3,900 airborne
  // with callsigns over the continental US). OpenSky never completes
  // from Vercel's serverless runtime even with a 25s timeout, so it is
  // now only the fallback. The last-good fallback in buildFeeds serves
  // the last successful result with its age if both fail.
  // Alternatives checked 2026-11-08 and rejected: airplanes.live (403,
  // needs allowlisting), adsb.one (Cloudflare-blocked), adsb.fi (API
  // paths 404), Flightradar24 (Cloudflare-blocked), ADS-B Exchange /
  // FlightAware / AviationStack (need API keys).
  try {
    const data = JSON.parse(
      await fetchText(
        "https://api.adsb.lol/v2/lat/39/lon/-98/dist/1500",
        25000
      )
    );
    const ac = Array.isArray(data.ac) ? data.ac : [];
    const airborne = ac
      .filter((a) => a && typeof a.alt_baro === "number" && (a.flight || "").trim())
      .map((a) => ({
        id: a.hex || ("A" + Math.random().toString(36).slice(2, 8)),
        callsign: String(a.flight).trim(),
        country: "",
        lat: a.lat,
        lon: a.lon,
        alt: Math.round(a.alt_baro),
        speed: a.gs != null ? Math.round(a.gs) : null,
        heading: a.track != null ? Math.round(a.track) : null,
      }))
      .sort((x, y) => (y.alt || 0) - (x.alt || 0))
      .slice(0, 8);
    if (!airborne.length) throw new Error("adsb.lol returned no airborne flights");
    return airborne;
  } catch (e) {
    // fall through to the OpenSky fallback
  }
  // OpenSky fallback, small box only — adsb.lol already covers the
  // full US, so only one 15s OpenSky attempt is worth the time.
  const data = JSON.parse(
    await fetchText(
      "https://opensky-network.org/api/states/all?lamin=30&lomin=-110&lamax=45&lomax=-75",
      15000
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

// ---- last-good fallback (estates + flights) ----

// In-memory store, per warm function instance: when a fresh fetch of
// estates or flights fails, serve the last successful result and label
// it with its age, so the feed shows real recent items instead of
// going empty. Never invented — stale data always carries its age.
// Note: a cold start or a different Vercel instance has no last-good
// data yet, so the first-ever failure still shows the "temporarily
// unavailable" message.
const lastGood = {
  estates: { at: 0, items: null },
  flights: { at: 0, items: null },
};

function ageLabel(at) {
  const mins = Math.max(0, Math.floor((Date.now() - at) / 60000));
  if (mins < 1) return "updated just now";
  if (mins < 60) return "updated " + mins + " min ago";
  const h = Math.floor(mins / 60);
  if (h < 24) return "updated " + h + (h === 1 ? " hour ago" : " hours ago");
  return "updated " + Math.floor(h / 24) + "d ago";
}

async function withLastGood(key, fetcher) {
  try {
    const items = await fetcher();
    if (items && items.length) {
      lastGood[key] = { at: Date.now(), items };
      return { items, stale: null };
    }
    throw new Error("no items returned");
  } catch (e) {
    const lg = lastGood[key];
    if (lg.items && lg.items.length) {
      return {
        items: lg.items,
        stale: { label: ageLabel(lg.at), fetchedAt: new Date(lg.at).toISOString() },
      };
    }
    throw e;
  }
}

// Recompute stale age labels from their fetchedAt timestamps, so a
// cached response never understates how old its last-good data is.
function refreshStaleLabels(data) {
  if (!data || !data.stale) return data;
  for (const k of ["estates", "flights"]) {
    const st = data.stale[k];
    if (st && st.fetchedAt) st.label = ageLabel(Date.parse(st.fetchedAt));
  }
  return data;
}

// ---- handler ----

async function buildFeeds() {
  const settled = await Promise.allSettled([
    fetchAntiques(),
    fetchNews(),
    withLastGood("estates", fetchEstates),
    fetchChefs(),
    withLastGood("flights", fetchFlights),
  ]);
  const keys = ["antiques", "news", "estates", "chefs", "flights"];
  const data = { updatedAt: new Date().toISOString(), errors: {}, stale: { estates: null, flights: null } };
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") {
      const v = r.value;
      if (v && typeof v === "object" && "items" in v) {
        data[keys[i]] = v.items;
        data.stale[keys[i]] = v.stale;
      } else {
        data[keys[i]] = v;
      }
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
      return res.status(200).json(refreshStaleLabels(cache.data));
    }
    const data = await buildFeeds();
    cache = { at: Date.now(), data };
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json(refreshStaleLabels(data));
  } catch (e) {
    return res.status(500).json({ error: "feeds failed", message: String((e && e.message) || e) });
  }
};
