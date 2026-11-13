# puneeth-alaina.com

Static pages served by GitHub Pages at https://puneeth-alaina.com.

## How pages map to URLs

Each page lives in its own folder as `index.html`:

| File | URL |
| --- | --- |
| `mexico-vacation/index.html` | puneeth-alaina.com/mexico-vacation (locked: see Locked pages) |
| `india-trip/index.html` | puneeth-alaina.com/india-trip |
| `thank-you-sticker/index.html` | puneeth-alaina.com/thank-you-sticker |
| `to-do/index.html` | puneeth-alaina.com/to-do |
| `grocery-list/index.html` | puneeth-alaina.com/grocery-list |
| `calendar/index.html` | puneeth-alaina.com/calendar |
| `birthday-weekend/index.html` | puneeth-alaina.com/birthday-weekend |
| `print-studio/index.html` | puneeth-alaina.com/print-studio |
| `wedding-venues/index.html` | puneeth-alaina.com/wedding-venues |
| `weekends/index.html` | puneeth-alaina.com/weekends (one subfolder per weekend, e.g. `weekends/2026-10-17/`) |
| `fitness/index.html` | puneeth-alaina.com/fitness (unlisted: not linked from the home page) |
| `procore-financials/index.html` | puneeth-alaina.com/procore-financials |

To add a page: create `new-page-name/index.html` (a complete HTML document) and add a link to it in the root `index.html`.

## Setup notes

- `CNAME` sets the custom domain. Don't delete it.
- `.nojekyll` tells GitHub Pages to serve files as-is, without Jekyll.
- `robots.txt` and `noindex` tags keep these pages out of search engines. Anyone with a link can still open them.
- The root `*.html` files are redirects from the original upload names.

## Shared lists (Firebase)

`to-do/`, `grocery-list/`, `calendar/`, `fitness/` and `wedding-venues/` read and write a shared Firestore database (project `puneeth-alaina`) through `shared/firebase.js`. Visitors sign in with Google on every one of these pages (the to-do list included, since Nov 2026); the Firestore security rules decide which accounts can see or edit anything. A page's sign-in screen only hides the page: the rules for its collections (`todo` and `meta` for the to-do list) are what actually keep other people out. The Firebase config in `shared/firebase.js` is public by design.

## Locked pages (`mexico-vacation/`)

For a static page that should only open for the approved Google accounts. The repo is public, so the real page is not committed: the folder holds a small sign-in shell (`index.html`, which calls `bootLocked()` from `shared/locked.js`) and the page itself as an encrypted `page.enc.json`.

- Pages are encrypted to the site's public key, `shared/page-key.pub.json` (ECDH P-256 + AES-GCM, code in `shared/page-crypto.js`). The matching private key is in Firestore at `weekends/page-keys`, a collection the rules already limit to the approved accounts. It got there from a one-time setup link (`/mexico-vacation/#k=…`): the first signed-in open with that link saved it. It is not stored anywhere else.
- To publish or update a locked page: `node tools/lock-page.mjs path/to/plain.html folder-name`, then commit the new `page.enc.json`. No key or setup link is needed for this.
- To lock another page: copy the `mexico-vacation/index.html` shell into its folder, change the title and dates, and run the tool.
- Never commit the plain HTML. The plain Monterrey page is kept as Puneeth's private Claude artifact "Monterrey New Year"; edit that, then re-run the tool. Versions of the page from before Nov 2026 are still in this repo's git history.

## Icons

`icons/` holds the tab and home-screen icons: `amp` (home and misc pages), `check` (to-do), `basket` (grocery list), `calendar` (calendar), `plane` (trip pages), `apple` (food log), `venue` (wedding venues). Each has an `.svg` for browser tabs, a `-32.png` fallback and a `-180.png` for iPhone home screens. New pages should link one in their `<head>`. `favicon.ico` at the root is the default for anything that doesn't.

## Food log (`fitness/`)

Collections: `fitnessLog` (one doc per logged item, keyed by `wd` = person_date), `fitnessFoods` (shared food library; scanned foods are stored as `bc` + 13-digit barcode), `fitnessProfiles` (daily targets per person). Barcodes are looked up in the library first, then Open Food Facts, then USDA FoodData Central. Search uses USDA (`USDA_KEY` at the top of the page script, Puneeth's free key). `fitnessProfiles` also holds each person's accent color; light/dark is saved per phone. "Fill from a photo of the label" posts the photo to the grocery worker's `/label` route (Claude Haiku reads the Nutrition Facts panel). `fitness/vendor/` holds the barcode reader used on phones without a built-in one (iPhone Safari).

## Wedding venues (`wedding-venues/`)

Collection `weddingVenues`, one doc per venue. Text fields are free text; `est` is a number (rough all-in cost) with `estNote`; `rP`/`rA` are 0–5 star ratings; `tour` is a local `YYYY-MM-DDTHH:MM` string. All venue data lives only in Firestore; the page holds no venue content. (The original 13 venues were imported once in Oct 2026; the import code has since been removed.) Columns are defined in the `COLS` list at the top of the page script.

## Weekends (`weekends/`)

Signed-in only. `weekend.js` and `weekend.css` are shared; each weekend is a folder named by its Saturday date holding a small `index.html` shell. Collection `weekends`, one doc per weekend (id = folder name) with `days`, `items` (timetable), `todos`, `week` (cleaning plan), `places`, `notes`. Optional: `guide` (read-only "Know before you go" cards: `title`, `intro`, `points` of `{lead, text}`, source `links`), `guideHint`, `links` on an item (https only), `weather.start`/`weather.end` to narrow the forecast, `weather.tz` for a trip outside Central time (default `America/Chicago`), and `who: "S"` for Sri & Sudhamsh. A plan can start before the weekend (prep days); with more than three days the day tabs scroll on phones. No plan content is committed: a new weekend ships as an AES-GCM-encrypted `seed.json`, and the key only lives in a one-time setup link (`#k=…`). The first signed-in open with that link writes the plan to Firestore; after that `seed.json` can be deleted.

## Procore financials (`procore-financials/`)

Static page, no Firebase. All figures live at the top of the page script in USD thousands, as filed: `RAW` holds the three statements (one array of FY2023–FY2025 values per line, plus the "What it is" and "At Procore" text), `SUPP` holds earnings-release figures (non-GAAP, customers, RPO, shares outstanding), and `P22` holds the FY2022 values used for growth rates and averages. `EDGES` lists the cross-statement connections and `RG` defines the ratios. To add a year, append a value to every array and to `YRS`/`YEND`. The share price default for the valuation group is `state.price`.
