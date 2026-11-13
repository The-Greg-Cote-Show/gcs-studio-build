# GCS Studio Build

Private task board for building out the GCS studio. Greg, Chris and Yeti each have their own private link. Not public.

- `docs/` is the page (GitHub Pages serves this folder).
- `worker/` is the API (a Cloudflare Worker with a D1 database).
- `scripts/make-links.mjs` makes the three private links.

Setup steps are in [SETUP.md](SETUP.md).

To rename a status, change its `label` in `STATUSES` at the top of `worker/src/index.js`. To restyle, everything is in `docs/styles.css`, starting with the THEME block.
