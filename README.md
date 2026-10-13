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
| `birthday-weekend/index.html` | puneeth-alaina.com/birthday-weekend |
| `print-studio/index.html` | puneeth-alaina.com/print-studio |

To add a page: create `new-page-name/index.html` (a complete HTML document) and add a link to it in the root `index.html`.

## Setup notes

- `CNAME` sets the custom domain. Don't delete it.
- `.nojekyll` tells GitHub Pages to serve files as-is, without Jekyll.
- `robots.txt` and `noindex` tags keep these pages out of search engines. Anyone with a link can still open them.
- The root `*.html` files are redirects from the original upload names.
