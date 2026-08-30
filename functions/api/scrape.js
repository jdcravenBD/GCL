/**
 * GET /api/scrape?url=<product page url>
 *
 * Fetches a product page server-side (a browser can't, because of CORS) and
 * returns a ranked list of candidate product images.
 *
 * Zero dependencies: parsing uses Cloudflare's built-in HTMLRewriter.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Filename tokens that are almost never the product photo.
const JUNK = new RegExp(
  '(^|[\\/_.-])(' +
    'logos?|icons?|sprites?|badges?|placeholder|spacer|blank|pixel|avatar|' +
    'flags?|social|facebook|instagram|youtube|twitter|pinterest|tiktok|' +
    'visa|mastercard|amex|paypal|klarna|afterpay|affirm|trustpilot|' +
    'stars?|rating|swatch|loading|loader|cart|search|menu|close|arrow' +
  ')([\\/_.-]|$)',
  'i'
);

// Query params CDNs use for resizing. Stripped when de-duplicating, so the
// 200px thumbnail and the 1600px zoom of one photo collapse into one entry.
const SIZE_PARAMS = [
  'width', 'height', 'w', 'h', 'size', 'quality', 'q', 'fit', 'crop',
  'dpr', 'format', 'auto', 'resize', 'scale', 'sw', 'sh', 'v', 'cache'
];

function isPrivateHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === '[::1]' || h === '::1') return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

// HTMLRewriter hands back raw attribute text, so a srcset written as
// "photo.jpg?v=1&amp;width=800" arrives still escaped. Left alone, the CDN
// sees a bogus "amp;width" param and de-duplication misses the match.
function decodeEntities(s) {
  if (!s || s.indexOf('&') === -1) return s;
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (m, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function absolutize(src, base) {
  if (!src) return null;
  const s = decodeEntities(src).trim();
  if (!s || s.startsWith('data:') || s.startsWith('blob:')) return null;
  try {
    const u = new URL(s, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Pick the highest-resolution entry out of a srcset attribute. */
function largestFromSrcset(srcset, base) {
  if (!srcset) return null;
  let best = null;
  let bestW = -1;
  for (const part of decodeEntities(srcset).split(',')) {
    const bits = part.trim().split(/\s+/);
    if (!bits[0]) continue;
    const abs = absolutize(bits[0], base);
    if (!abs) continue;
    let width = 1;
    const d = bits[1];
    if (d && d.endsWith('w')) width = parseInt(d, 10) || 1;
    else if (d && d.endsWith('x')) width = (parseFloat(d) || 1) * 1000;
    if (width > bestW) {
      bestW = width;
      best = abs;
    }
  }
  return best;
}

/** Collapse trivially-different URLs that point at the same photo. */
function dedupeKey(rawUrl) {
  try {
    const u = new URL(rawUrl);
    for (const p of SIZE_PARAMS) u.searchParams.delete(p);
    // Shopify / Magento style: name_800x800.jpg, name-1200x.png
    u.pathname = u.pathname.replace(/[_-]\d{2,5}x\d{0,5}(?=\.[a-z]{3,4}$)/i, '');
    // Sweetwater / Thomann style size directories: /images/750/foo.jpg
    u.pathname = u.pathname.replace(/\/\d{2,4}(?=\/[^/]+$)/, '');
    return (u.host + u.pathname + u.search).toLowerCase();
  } catch {
    return rawUrl.toLowerCase();
  }
}

// Generic filename words that say nothing about which product a photo is of.
const WEAK_TOKENS = new Set([
  'image', 'images', 'photo', 'photos', 'product', 'products', 'shop',
  'files', 'file', 'media', 'main', 'thumb', 'thumbs', 'large', 'small',
  'default', 'front', 'back', 'view', 'copy', 'final', 'edit', 'web',
  'jpeg', 'webp', 'original', 'full', 'zoom'
]);

/** Distinctive words in an image's filename, used to group photos of one part. */
function stemTokens(rawUrl) {
  const out = new Set();
  let path;
  try {
    path = new URL(rawUrl).pathname;
  } catch {
    return out;
  }
  const file = (path.split('/').pop() || '').replace(/\.[a-z0-9]{2,5}$/i, '');
  for (const tok of file.toLowerCase().split(/[^a-z0-9]+/)) {
    if (tok.length >= 4 && !WEAK_TOKENS.has(tok)) out.add(tok);
  }
  return out;
}

/**
 * Turn whatever a store writes into a number. Prices arrive as "1,299.00",
 * "1.299,00", "US $1,299", "1299" — the last separator with two or fewer
 * digits after it is the decimal point, everything else is grouping.
 */
function normalizePrice(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/[^\d.,]/g, '');
  if (!s) return null;

  const dec = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
  let intPart = s;
  let fracPart = '';
  if (dec > -1 && dec !== s.length - 1 && s.length - dec - 1 <= 2) {
    intPart = s.slice(0, dec);
    fracPart = s.slice(dec + 1);
  }
  intPart = intPart.replace(/[.,]/g, '');

  const n = parseFloat(intPart + (fracPart ? '.' + fracPart : ''));
  return isFinite(n) && n >= 0 ? n : null;
}

/** Walk arbitrary JSON-LD looking for schema.org offers. */
function harvestOffers(node, out, depth) {
  depth = depth || 0;
  if (!node || depth > 8) return;
  if (Array.isArray(node)) {
    for (const n of node) harvestOffers(n, out, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;

  if (node.offers) {
    const offers = Array.isArray(node.offers) ? node.offers : [node.offers];
    for (const o of offers) {
      if (!o || typeof o !== 'object') continue;
      const spec = o.priceSpecification && typeof o.priceSpecification === 'object'
        ? o.priceSpecification
        : null;
      // lowPrice covers AggregateOffer, where a range is given instead.
      const raw = o.price != null ? o.price
        : spec && spec.price != null ? spec.price
        : o.lowPrice;
      const value = normalizePrice(raw);
      if (value != null) {
        out.push({
          value: value,
          currency: o.priceCurrency || (spec && spec.priceCurrency) || null
        });
      }
    }
  }
  for (const k of Object.keys(node)) {
    if (k === 'offers') continue;
    harvestOffers(node[k], out, depth + 1);
  }
}

/** Walk arbitrary JSON-LD looking for schema.org Product image fields. */
function harvestJsonLd(node, out, depth) {
  depth = depth || 0;
  if (!node || depth > 8) return;
  if (Array.isArray(node)) {
    for (const n of node) harvestJsonLd(n, out, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;

  const type = node['@type'];
  const types = Array.isArray(type) ? type.join(' ') : String(type || '');
  const isProduct = /product|itempage|offer/i.test(types);

  if (node.image) {
    const imgs = Array.isArray(node.image) ? node.image : [node.image];
    imgs.forEach(function (img, i) {
      const val = typeof img === 'string' ? img : (img && (img.url || img.contentUrl));
      // First gallery entry ranks just under og:image; later ones descend.
      if (val) out.push({ url: val, score: (isProduct ? 90 : 70) - i });
    });
  }
  for (const k of Object.keys(node)) {
    if (k === 'image') continue;
    harvestJsonLd(node[k], out, depth + 1);
  }
}

export async function onRequestGet(context) {
  const reqUrl = new URL(context.request.url);
  const target = reqUrl.searchParams.get('url');

  const json = (body, status) =>
    new Response(JSON.stringify(body), {
      status: status || 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
        'cache-control': 'public, max-age=86400'
      }
    });

  if (!target) return json({ error: 'Missing ?url=' }, 400);

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return json({ error: 'That does not look like a valid URL.' }, 400);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return json({ error: 'Only http and https URLs are supported.' }, 400);
  }
  if (isPrivateHost(parsed.hostname)) {
    return json({ error: 'That host is not allowed.' }, 400);
  }

  // ---- fetch the page -----------------------------------------------------
  let res;
  try {
    res = await fetch(parsed.toString(), {
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000)
    });
  } catch (e) {
    return json({
      error: 'Could not reach that page.',
      detail: String((e && e.message) || e),
      blocked: true
    }, 502);
  }

  if (!res.ok) {
    const blocked = res.status === 403 || res.status === 429 || res.status === 503;
    const message =
      res.status === 404
        ? 'That page does not exist (404). Check the URL.'
        : blocked
        ? 'That store is blocking automated requests (' + res.status + '). Paste the image URL manually.'
        : 'That store returned ' + res.status + '.';
    return json({ error: message, status: res.status, blocked: blocked }, 502);
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('html')) {
    // Someone pasted a direct image link. Hand it straight back.
    if (contentType.startsWith('image/')) {
      return json({ pageUrl: res.url, title: null, images: [res.url], count: 1 });
    }
    return json({ error: 'That URL is not a web page.' }, 415);
  }

  // ---- parse --------------------------------------------------------------
  const base = res.url || parsed.toString();
  const candidates = [];
  const ldChunks = [];
  let title = '';
  let ogTitle = null;
  let metaPrice = null;
  let metaCurrency = null;

  const push = (raw, score) => {
    const abs = absolutize(raw, base);
    if (abs) candidates.push({ url: abs, score: score });
  };

  const rewriter = new HTMLRewriter()
    .on('meta', {
      element(el) {
        const key = (
          el.getAttribute('property') ||
          el.getAttribute('name') ||
          el.getAttribute('itemprop') ||
          ''
        ).toLowerCase();
        const content = el.getAttribute('content');
        if (!content) return;
        if (key === 'og:image' || key === 'og:image:secure_url' || key === 'og:image:url') {
          push(content, 100);
        } else if (key === 'twitter:image' || key === 'twitter:image:src') {
          push(content, 85);
        } else if (key === 'og:title') {
          ogTitle = content;
        } else if (
          key === 'product:price:amount' || key === 'og:price:amount' || key === 'price'
        ) {
          if (metaPrice == null) metaPrice = normalizePrice(content);
        } else if (
          key === 'product:price:currency' || key === 'og:price:currency' ||
          key === 'pricecurrency'
        ) {
          if (!metaCurrency) metaCurrency = content.trim().toUpperCase();
        }
      }
    })
    .on('link[rel~="image_src"]', {
      element(el) {
        push(el.getAttribute('href'), 80);
      }
    })
    .on('title', {
      text(t) {
        title += t.text;
      }
    })
    .on('script[type="application/ld+json"]', {
      element() {
        ldChunks.push('');
      },
      text(t) {
        if (ldChunks.length) ldChunks[ldChunks.length - 1] += t.text;
      }
    })
    .on('img', {
      element(el) {
        // Lazy-loading means the real photo often lives in a data-* attribute
        // rather than in src. Check the high-res ones first.
        const zoom =
          el.getAttribute('data-zoom-image') ||
          el.getAttribute('data-large_image') ||
          el.getAttribute('data-large') ||
          el.getAttribute('data-full') ||
          el.getAttribute('data-original');
        if (zoom) push(zoom, 62);

        const fromSrcset = largestFromSrcset(
          el.getAttribute('srcset') || el.getAttribute('data-srcset'),
          base
        );
        if (fromSrcset) candidates.push({ url: fromSrcset, score: 55 });

        const lazy = el.getAttribute('data-src') || el.getAttribute('data-image');
        if (lazy) push(lazy, 50);

        const src = el.getAttribute('src');
        if (src) {
          // Declared dimensions let us drop obvious page chrome before scoring.
          const w = parseInt(el.getAttribute('width') || '0', 10);
          const h = parseInt(el.getAttribute('height') || '0', 10);
          if ((w && w < 120) || (h && h < 120)) return;
          const alt = (el.getAttribute('alt') || '').toLowerCase();
          const cls = (el.getAttribute('class') || '').toLowerCase();
          const boost = /product|gallery|main|hero|zoom|detail/.test(cls + ' ' + alt) ? 15 : 0;
          push(src, 40 + boost);
        }
      }
    })
    .on('picture source', {
      element(el) {
        const best = largestFromSrcset(el.getAttribute('srcset'), base);
        if (best) candidates.push({ url: best, score: 58 });
      }
    });

  try {
    await rewriter.transform(res).arrayBuffer();
  } catch (e) {
    return json({
      error: 'Could not parse that page.',
      detail: String((e && e.message) || e)
    }, 500);
  }

  const offers = [];
  for (const chunk of ldChunks) {
    const text = chunk.trim();
    if (!text) continue;
    try {
      const parsed = JSON.parse(text);
      const found = [];
      harvestJsonLd(parsed, found);
      for (const f of found) push(f.url, f.score);
      harvestOffers(parsed, offers);
    } catch {
      // Malformed JSON-LD is common in the wild. Skip it quietly.
    }
  }

  // Structured offers are the most trustworthy; meta tags are the fallback.
  // Where a page lists several, the lowest is the single-unit price far more
  // often than not — bundles and multipacks sit above it.
  let price = null;
  let currency = null;
  if (offers.length) {
    offers.sort((a, b) => a.value - b.value);
    price = offers[0].value;
    currency = offers[0].currency;
  } else if (metaPrice != null) {
    price = metaPrice;
    currency = metaCurrency;
  }
  if (!currency && metaCurrency) currency = metaCurrency;

  // ---- rank, filter, dedupe ----------------------------------------------

  // The top-scoring candidate (nearly always og:image) is the known-good
  // product shot. Other photos whose filenames share a distinctive word with
  // it are almost certainly the rest of that product's gallery, so lift them
  // above site furniture like promo banners that scored well structurally.
  let anchorTokens = new Set();
  let bestScore = -1;
  for (const c of candidates) {
    if (c.score > bestScore) {
      bestScore = c.score;
      anchorTokens = stemTokens(c.url);
    }
  }
  if (anchorTokens.size) {
    for (const c of candidates) {
      for (const tok of stemTokens(c.url)) {
        if (anchorTokens.has(tok)) {
          c.score += 12;
          break;
        }
      }
    }
  }

  const seen = new Map();
  for (const c of candidates) {
    let path = c.url;
    try {
      path = new URL(c.url).pathname;
    } catch {
      // keep the raw string
    }
    if (JUNK.test(path)) continue;
    if (/\.svg(\?|$)/i.test(path)) continue;

    const key = dedupeKey(c.url);
    const prev = seen.get(key);
    if (!prev || c.score > prev.score) seen.set(key, c);
  }

  const images = Array.from(seen.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 24)
    .map(c => c.url);

  const cleanTitle = (ogTitle || title || '').replace(/\s+/g, ' ').trim() || null;

  return json({
    pageUrl: res.url,
    title: cleanTitle,
    images: images,
    count: images.length,
    price: price,
    currency: currency
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'content-type'
    }
  });
}
