# puneeth-alaina.com

Static pages served by GitHub Pages at https://puneeth-alaina.com.

## How pages map to URLs

Each page lives in its own folder as `index.html`:

| File | URL |
| --- | --- |
| `mexico-vacation/index.html` | puneeth-alaina.com/mexico-vacation |
| `india-trip/index.html` | puneeth-alaina.com/india-trip |
| `thank-you-sticker/index.html` | puneeth-alaina.com/thank-you-sticker |
| `to-do/index.html` | puneeth-alaina.com/to-do |
| `grocery-list/index.html` | puneeth-alaina.com/grocery-list |
| `birthday-weekend/index.html` | puneeth-alaina.com/birthday-weekend |
| `print-studio/index.html` | puneeth-alaina.com/print-studio |

To add a page: create `new-page-name/index.html` (a complete HTML document) and add a link to it in the root `index.html`.

## Setup notes

- `CNAME` sets the custom domain. Don't delete it.
- `.nojekyll` tells GitHub Pages to serve files as-is, without Jekyll.
- `robots.txt` and `noindex` tags keep these pages out of search engines. Anyone with a link can still open them.
- The root `*.html` files are redirects from the original upload names.

## Shared lists (Firebase)

`to-do/` and `grocery-list/` read and write a shared Firestore database (project `puneeth-alaina`) through `shared/firebase.js`. Visitors sign in with Google; the Firestore security rules decide which accounts can see or edit anything. The Firebase config in `shared/firebase.js` is public by design.

## Icons

`icons/` holds the tab and home-screen icons: `amp` (home and misc pages), `check` (to-do), `basket` (grocery list), `plane` (trip pages). Each has an `.svg` for browser tabs, a `-32.png` fallback and a `-180.png` for iPhone home screens. New pages should link one in their `<head>`. `favicon.ico` at the root is the default for anything that doesn't.
