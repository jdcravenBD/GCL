/**
 * Share links.
 *
 *   POST /api/share        body: a board JSON  ->  { id }
 *   GET  /api/share?id=xx                      ->  the stored board JSON
 *
 * Backed by a Cloudflare KV namespace bound as BOARDS. A shared board is a
 * snapshot, not a live document: opening the link gives you the board as it
 * was when the link was made.
 */

const MAX_BYTES = 1024 * 1024;          // a board of any sane size is far under this
const TTL_SECONDS = 60 * 60 * 24 * 365; // a year

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

/** Short, URL-safe, and random enough that ids can't be guessed by walking. */
function newId() {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += b.toString(36).padStart(2, '0');
  return out.slice(0, 14);
}

export async function onRequestPost(context) {
  const env = context.env;
  if (!env.BOARDS) {
    return json({
      error: 'Sharing is not set up on this deployment — no storage is bound.'
    }, 501);
  }

  let body;
  try {
    body = await context.request.text();
  } catch {
    return json({ error: 'Could not read the board.' }, 400);
  }

  if (!body || body.length > MAX_BYTES) {
    return json({ error: 'That board is too large to share.' }, 413);
  }

  // Store the raw text, but only after proving it parses and looks like a board.
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return json({ error: 'That is not a board.' }, 400);
  }
  if (!parsed || !Array.isArray(parsed.blocks)) {
    return json({ error: 'That is not a board.' }, 400);
  }

  const id = newId();
  try {
    await env.BOARDS.put('board:' + id, body, { expirationTtl: TTL_SECONDS });
  } catch (e) {
    return json({ error: 'Could not save the board.', detail: String(e && e.message || e) }, 500);
  }

  return json({ id: id });
}

export async function onRequestGet(context) {
  const env = context.env;
  if (!env.BOARDS) {
    return json({ error: 'Sharing is not set up on this deployment.' }, 501);
  }

  const id = new URL(context.request.url).searchParams.get('id');
  if (!id || !/^[a-z0-9]{1,32}$/.test(id)) {
    return json({ error: 'Bad link.' }, 400);
  }

  let body;
  try {
    body = await env.BOARDS.get('board:' + id);
  } catch (e) {
    return json({ error: 'Could not read that board.' }, 500);
  }
  if (!body) {
    return json({ error: 'That link has expired, or never existed.' }, 404);
  }

  return new Response(body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=300'
    }
  });
}
