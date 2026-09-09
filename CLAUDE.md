# ARCH X Archive — working notes

An Obsidian plugin that archives X/Twitter profiles and single posts into the
vault as notes, in bulk, driven by `gallery-dl`.

Read `CHANGELOG.md` before changing behaviour. It is the reliable record of why
things are the way they are, and it is kept current.

## Why gallery-dl and not something else

There is no free X API for timelines any more, so the choices were:

1. **gallery-dl with browser cookies** — chosen. It already knows X's internal
   endpoints, handles pagination, threads, quoted posts and media, and it is
   maintained against X's changes by people who do nothing else.
2. Direct calls to X's internal GraphQL endpoints. No dependency, but the
   endpoint hashes change without notice and the plugin becomes the thing that
   has to be maintained against X.
3. Web Clipper, one profile at a time. That is the manual work this replaces.

The shape is deliberately the same as ARCH YT Playlists: an external tool does
the fetching, this plugin owns enumeration, note writing and the queue.

## Things that cost hours to learn

**gallery-dl publishes no prebuilt binaries.** Checked against the eight most
recent releases (up to v1.32.11): every one has zero release assets. The yt-dlp
approach in ARCH YT Playlists — download a standalone executable into the
plugin's `bin/` — cannot be copied here.

`installGalleryDl()` builds a private venv at `bin/venv` with the system
`python3` and pip-installs into it. That keeps the install self-contained and
removable with the plugin folder, and it does not touch the user's Python.
Homebrew is the documented manual fallback. Do not "restore" a binary download
path; there is nothing to download.

**A tweet with no image is not media, and gallery-dl is a media downloader.**
Without `-o extractor.twitter.text-tweets=true` every text-only post is silently
missing from the output — not an error, just absent, which looks exactly like an
empty timeline. This flag is on by default in `buildArgs`, and turning it off
turns this into a media archiver.

**`author` and `user` are different people.** In gallery-dl's twitter metadata,
`author` wrote the post and `user` owns the timeline it was found on. On a repost
they differ, and using `user` files someone else's words under your subject's
name. `authorOf()` prefers `author`; keep it that way.

**One post can produce several `Url` entries** — one per photo — so `-j` output
is not one row per post. `groupByTweet()` folds them back together by
`tweet_id`. Counting rows and calling that a post count is wrong by a factor of
up to four.

**`--config-ignore` is passed on every call, deliberately.** Without it
gallery-dl reads `~/.config/gallery-dl/config.json`, so a user's own config
silently overrides what the settings tab says and the plugin's behaviour becomes
unreproducible. If a config file is ever wanted, write one and pass `--config`.

**The post index is built once per sync run.** `findByPostId` used to scan every
markdown file in the vault; at 150 profiles × 200 posts that is 30,000 full-vault
scans. `buildPostIndex()` runs once and is updated as notes are written, because
`metadataCache` has not seen a note created moments earlier — the same trap ARCH
YT Playlists hit with `byId`.

**An existing post note is never rewritten.** Like and repost counts change
constantly; refreshing them would rewrite the entire archive on every sync and
make the vault's git history useless. Identity is `x-post-id`, not the filename,
so changing the name template does not create duplicates.

## Rate limiting, which is the real constraint

X rate-limits an authenticated session aggressively, and 150 profiles is a lot of
requests. Three settings exist for this and all three matter:

- `sleepRequest` (`--sleep-request`) — the most effective one
- `maxPerProfile` (`--range 1-N`) — fetch recent posts, not whole timelines
- `useDownloadArchive` (`--download-archive`) — so a re-run is cheap

A 429 is reported through `explain()` with the fix rather than as a raw stderr
dump, because the raw message does not say what to do about it.

## Cookies

Read from the browser at the moment of each run via `--cookies-from-browser`;
nothing is stored by the plugin. Safari is detected but deprioritised in
`autoConfigure` — its cookie store needs Full Disk Access, which fails in a way
that looks like a login problem rather than a permissions one.

Note that `data.json` holds the cookie *source* and the profile list, which is
why it is gitignored.

## The `lib()` split

Nothing in `lib/` may `require('obsidian')`. That module is injected into
`main.js`'s scope only; a file loaded from disk by plain Node cannot resolve it,
and `build.mjs` lists `obsidian` as external so a stray require fails loudly at
build time rather than silently at load time.

`lib()` takes `ARCH_LIB` when the bundle defined it and falls back to reading
`lib/` from disk when it did not. That fallback keeps the repo runnable unbuilt:
edit, reload in Obsidian, no build step. Keep both halves.

## Releasing

`npm run build` writes `dist/main.js` and `dist/manifest.json`. Verify a release
the way it actually installs: copy only those two files into a folder with no
`lib/`, and load it.

## Not yet built

This is a scaffold with a working enumeration and note-writing path. Still open:

- **Media download.** `downloadMedia`, `mediaLocationMode`, `mediaSubfolder` and
  `mediaFolder` are in the settings object but nothing reads them. The second
  pass — run gallery-dl without `--dump-json` into a temp dir, move files into
  the vault, write `media` and `dl-ed` into the note — is the next piece. Copy
  the disk-check discipline from ARCH YT Playlists: whether a download happened
  is decided by looking for the file, never by trusting a property.
- **Threads.** `conversation_id` is in the metadata but nothing groups a thread
  into one note.
- **Single-post URLs.** `promptForUrl` currently treats any x.com URL as a
  profile. A `/status/` URL should archive just that post.
- **Nothing has been run against a real timeline yet.** Every claim above about
  gallery-dl's flags comes from its documentation, not from a run. Verify against
  one profile with `maxPerProfile: 5` before pointing it at 150.
