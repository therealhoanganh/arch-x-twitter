# ARCH X Twitter

Archives X/Twitter profiles into your Obsidian vault as notes — in bulk. Built
for keeping a reading list of a few hundred accounts, not for clipping one post
at a time.

## Status

Early. Enumeration and note writing work and have been checked against a live
timeline; **media download is not implemented yet**, and none of it has run
inside Obsidian. Try one profile with a small limit first.

## What it does

- Keep a list of profiles and sync them all with one command
- Paste 150 handles or URLs at once to build the list
- One note per post with the text, author, date, counts and a link back
- One note per profile with its bio and stats
- Posts already archived are left alone, so a re-run only adds what is new
- Per-profile choice of timeline: posts, with replies, media only, or likes

## Requirements

Desktop only, and two things:

- **gallery-dl** — the plugin can install it for you into a private Python
  environment inside its own folder, or use `brew install gallery-dl`
- **A browser you are logged into X with** — optional for Posts, which works via
  a guest token, but required for replies, media and likes. Cookies are read at
  the moment of each run and never stored by the plugin.

ffmpeg is only needed once video download exists.

## Rate limits

X limits an authenticated session hard, and a few hundred profiles is a lot of
requests. Three settings control this: seconds between requests, most recent
posts per profile, and the download archive that makes re-runs cheap. Start with
a small limit and raise it once a full sync completes.

## Install

Not in the community catalogue. Install with BRAT, or copy `main.js` and
`manifest.json` into `.obsidian/plugins/arch-x-twitter/`.

## Licence

MIT.
