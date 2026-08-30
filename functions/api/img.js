/**
 * GET /api/img?url=<image url>
 *
 * Fallback for images whose CDN refuses cross-origin hotlinking. The board
 * loads images directly first (free, no bandwidth cost to us) and only falls
 * back to this proxy when the direct <img> load fails.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const MAX_BYTES = 8 * 1024 * 1024;

function isPrivateHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === '[::1]' || h === '::1') return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

export async function onRequestGet(context) {
  const target = new URL(context.request.url).searchParams.get('url');
  if (!target) return new Response('Missing ?url=', { status: 400 });

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return new Response('Bad URL', { status: 400 });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return new Response('Unsupported protocol', { status: 400 });
  }
  if (isPrivateHost(parsed.hostname)) {
    return new Response('Host not allowed', { status: 400 });
  }

  let res;
  try {
    res = await fetch(parsed.toString(), {
      headers: {
        'user-agent': UA,
        accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        // Some CDNs serve the image only when the Referer looks like the
        // store's own page, so present the image's own origin.
        referer: parsed.origin + '/'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000)
    });
  } catch (e) {
    return new Response('Upstream fetch failed', { status: 502 });
  }

  if (!res.ok) return new Response('Upstream returned ' + res.status, { status: 502 });

  const type = res.headers.get('content-type') || '';
  if (!type.startsWith('image/')) return new Response('Not an image', { status: 415 });

  const length = parseInt(res.headers.get('content-length') || '0', 10);
  if (length && length > MAX_BYTES) return new Response('Image too large', { status: 413 });

  return new Response(res.body, {
    headers: {
      'content-type': type,
      'cache-control': 'public, max-age=604800, immutable',
      'access-control-allow-origin': '*'
    }
  });
}
