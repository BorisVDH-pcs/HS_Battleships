# Forwarding the old address

The site used to live at `https://borisvdh-pcs.github.io/HS_Battleships/`.
After the repo was renamed to `hs-events`, GitHub forwards old git and repo
links, but not the website, so the old address would show "page not found".

These files are a stand-in site at the old address. Each page sends the visitor
to the same page on the new site:
`/HS_Battleships/<anything>` → `/hs-events/<anything>`.

## Setting it up (once, after the rename)

1. On GitHub, create a new **public** repo named exactly `HS_Battleships`.
   The name only becomes free after the main repo has been renamed.
2. Upload `index.html` from this folder, then upload it a second time under the
   name `404.html`. GitHub Pages shows `404.html` for any address it has no
   file for, which is how deep links get forwarded too.
3. Go to Settings → Pages, choose **Deploy from a branch**, then `main` and `/ (root)`.
   Save.

After a minute or two, the old address forwards to the new one. Nothing in
this repo depends on it, so you can delete that repo later, once old links have
stopped going around.
