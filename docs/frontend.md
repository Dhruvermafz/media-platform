# Frontend

`apps/frontend` — React 18, Vite, TypeScript, React Router, TanStack Query.
No CSS framework: a small token-based stylesheet (`src/styles/`).

## What it does

Library (grid/list, date groups, S/M/L tiles, infinite scroll, filters, sort,
search) · full-screen viewer (zoom, video with quality switching, swipe/keyboard
navigation, details, tags, collections, renditions, job status) · multi-select
with bulk actions and undo · favourites · trash · collections · tags · sharing
(expiry, password, download control) and a public `/s/:token` page ·
concurrent upload queue with progress, retry and cancel, plus drag-and-drop
anywhere · live Processing page · Activity · Settings (profile, theme, usage,
password, install) · Operations (admins: workers, failed jobs, users/quotas).

## Design

The platform's distinguishing trait is its asynchronous pipeline, so that is the
one loud element: a tile still being processed shows a segmented **pipeline
strip** — one segment per job, filling as workers finish, driven by live events.
Everything else is deliberately quiet so the photos supply the colour (tiles even
use each photo's extracted dominant colour as their placeholder).

Cool paper, ink, and one cyanotype "Prussian" blue accent; Bricolage Grotesque
for titles and Figtree for UI, self-hosted through `@fontsource` so the PWA works
offline. Light and dark themes (system default); the viewer is always dark.
Tokens live in `src/styles/tokens.css`.

## Works across devices

| Width | Layout |
|---|---|
| ≥1024px | Sidebar (nav, tags, storage meter, account) · viewer with side panel |
| 640–1023px | Icon rail · viewer stacks image over a details panel |
| <640px | Bottom tab bar with a centre Upload button and a "More" sheet · dialogs become bottom sheets · long-press to select · 3-up grid |

Touch: long-press to select, swipe between items in the viewer, hover-only video
previews are disabled (no wasted mobile data), safe-area insets respected. Mouse
and keyboard: `/` search, `U` upload, `←/→` `F` `I` `Esc` in the viewer, Shift-click
range select. Focus is trapped in dialogs; controls have labels; motion respects
`prefers-reduced-motion`.

## Data flow

- **Server state** lives in TanStack Query (keys: `assets`, `asset`, `collections`,
  `tags`, `jobs`, `shares`, `usage`, `activity`, `admin`).
- **Live updates**: `lib/realtime.ts` reads the API's SSE stream with `fetch()`
  (so the JWT goes in a header, not a URL), reconnects with jittered backoff and
  refetches everything on reconnect. `context/RealtimeContext.tsx` maps each event
  to the queries it makes stale and coalesces bursts into one refetch per query
  every 250 ms. If the stream is down, lists poll — but only while something is
  still processing.
- **Uploads** (`context/UploadContext.tsx`): 3 concurrent; `upload-url` → XHR `PUT`
  (for progress) → `confirm`. One automatic retry on network errors, cancel via
  `xhr.abort()`, a warning if you close the tab mid-upload. Uploads started on a
  collection page land in that collection.
- **URL is state** for the library: `?q= &kind= &status= &sort= &asset=` — filters
  and the open item are shareable and survive refresh; the browser Back button
  closes the viewer.

## PWA

Installable (`manifest.webmanifest`, maskable icon). `public/sw.js` is
intentionally conservative: it caches only hashed build assets and the shell, and
**never** API responses or presigned media URLs (so a signed link can't be served
stale or outlive its permissions). Offline navigation shows the cached shell.
Registered in production builds only. nginx serves `sw.js` and `index.html` with
`no-cache` so deploys reach users immediately.

## Running it

```bash
cd apps/frontend
npm run dev          # Vite on :5173, proxying /api -> localhost:3000 (the real API)
npm run dev:mock     # same, against an in-memory mock API - no Postgres/Redis/S3 needed
npm run build        # type-check + production build into dist/
python3 e2e/smoke.py # browser smoke test (Playwright) against the mock API
```

The mock (`dev/mock-server.mjs`) implements the same routes and JSON shapes,
including the SSE stream and simulated worker progress after each upload. Sign in
with any email; `demo@example.com` and `admin@…` are admins. It is a dev tool, not
a second backend: no persistence and shallow validation. If you change an API
response shape, update `src/api/types.ts` and the mock together.
