# GCL — Guitar Parts Board

A free-form canvas for laying out guitar parts before you buy them. Drop a card
for each part, paste the product URL, and the app pulls the product photos off
that page so you can see the build come together. Cycle through the found images
when the first one isn't the right shot.

Runs entirely on free hosting. No database, no accounts, no monthly bill.

## Running it locally

```bash
npm install
```

```bash
npm run dev
```

Then open http://127.0.0.1:8788

## Deploying it for free

Cloudflare Pages' free tier covers this comfortably: unlimited static requests
and 100,000 function calls per day. Only the image lookup uses a function call,
so a heavy day of board-building is a few hundred.

```bash
npx wrangler pages deploy
```

First run prompts you to log in and name the project. After that, every deploy
is that one command. You can also connect a Git repo in the Cloudflare dashboard
and let it deploy on push.

## How the image lookup works

A browser can't read another site's HTML — the same-origin policy blocks it. So
`/api/scrape` does the fetch server-side and returns a ranked list of candidate
image URLs, which the board then cycles through.

Candidates are gathered in confidence order:

| Source | Score | Notes |
| --- | --- | --- |
| `og:image` | 100 | The share-preview image. Nearly always the hero product shot. |
| JSON-LD `Product.image` | 90 | Often the whole gallery as an array — the main source of extra images. |
| `twitter:image` | 85 | Fallback when `og:image` is absent. |
| `link[rel=image_src]` | 80 | Legacy, but still common. |
| `img[data-zoom-image]` and friends | 62 | High-res source on lazy-loading storefronts. |
| `srcset` / `<picture><source>` | 55–58 | Largest candidate in the set is taken. |
| `img[src]` | 40–55 | Boosted when the class or alt text looks product-related. |

Then, before ranking:

- **Entity decoding.** Attribute text arrives escaped (`?v=1&amp;width=800`).
  Left alone, that corrupts the URL and defeats de-duplication.
- **De-duplication.** CDN resize parameters (`width`, `dpr`, `v`, …) and size
  patterns in filenames (`photo_800x800.jpg`, `/images/750/photo.jpg`) are
  stripped to build the key, so one photo at six sizes collapses to one entry.
- **Junk filtering.** Logos, payment icons, star ratings, spacers, social
  buttons, SVGs, and anything declaring dimensions under 120px are dropped.
- **Gallery affinity.** The top-scoring image is treated as known-good, and
  other images sharing a distinctive filename word with it get a boost. This is
  what pushes the rest of a product's gallery above promo banners.

`/api/img` is a fallback proxy for images whose CDN refuses cross-origin
hotlinking. The board always tries loading directly first, so the proxy only
runs on the rare failure.

Both endpoints refuse private and loopback hosts, so the scraper can't be
pointed at anything on your own network.

## Sites that work, and the ones that don't

`og:image` exists so that Discord, iMessage, and Facebook can build link
previews — stores publish it deliberately, which is why this works as widely as
it does. Verified working: Allparts, StewMac, Thomann, Guitarfetish.

Some stores sit behind bot protection and return 403. Warmoth does; Amazon
generally will too. When that happens the card says so and you use
**Paste image URL** instead — right-click the photo on the store page, Copy
image address, paste. Five seconds, and it's stored the same way.

For Amazon specifically, the supported route is their Product Advertising API,
which needs an affiliate account.

## Board data

Everything lives in `localStorage` under `gcl.board.v1` — boards are per-browser
and never leave the machine. **Export** writes a JSON file, **Import** reads one
back, which is how you move a board between machines or keep a backup.

Image URLs are stored as links, not copies. If a store reorganizes its CDN, an
old board can end up with broken images. Re-run **Get** to refresh them.

## Layout

```
public/           static site (no build step)
  index.html
  styles.css
  app.js
functions/api/
  scrape.js       product page -> ranked image list
  img.js          hotlink fallback proxy
wrangler.toml
```

Zero runtime dependencies. Parsing uses Cloudflare's built-in `HTMLRewriter`;
Wrangler is only there to run and deploy.

## Controls

| Action | How |
| --- | --- |
| Move a card | Drag it |
| Pan | Drag the background |
| Zoom | Ctrl + scroll, or the toolbar buttons |
| Cycle images | Hover the photo, use ‹ › |
| Fetch images | Paste a URL, press Enter or click **Get** |
