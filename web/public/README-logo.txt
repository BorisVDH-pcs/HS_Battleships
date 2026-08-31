Save the High Society logo here as:  logo.png

Both the page header and the sign-in screen load it automatically. Until this
file exists they fall back to a gold "HS Battleships" wordmark, so nothing
breaks while it is missing.

Recommended: transparent-background PNG, ~600px wide. The header renders it
about 38px tall, the sign-in screen about 64px, so it is only ever scaled down.

It is kept out of git on purpose — see web/src/components/Wordmark.jsx.
