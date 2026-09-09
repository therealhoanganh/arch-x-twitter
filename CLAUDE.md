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

**Tweet ids do not survive `JSON.parse`.** X's ids are 19-digit snowflakes and
`Number.MAX_SAFE_INTEGER` is 16 digits, so `JSON.parse` silently rounds
`1812255561930731918` to `...920`. This is not theoretical: on the first live run
every post URL 404'd and the id used for de-duplication was wrong with it.

There is no parser option for this and a reviver is handed the number after the
damage, so `quoteBigIds()` rewrites id-shaped fields to strings in the raw text
before parsing. Every id in this plugin is a **string** from that point on. Do
not "tidy" them back to numbers, and do not compare an id with `==` against
something that has been through `Number()`.

**A tweet with no image produces no `Url` row at all.** Even with
`extractor.twitter.text-tweets=true`, a text-only post arrives as a **Directory**
row (type 2) carrying the full metadata including `content`; only media produce
`Url` rows (type 3). Measured on one live timeline: 66 posts → 66 Directory rows
and 3 Url rows. Reading `Url` rows alone — which is what a media downloader's
output looks like it should mean — drops almost every post.

**`--range` limits files. `--post-range` limits posts.** `--range 1-3` on a
timeline returned three media files and sixty-six posts. "Most recent N posts"
has to use `--post-range`; using `--range` for it silently fetches the whole
timeline.

**A bare `x.com/<name>` never returns posts.** It maps to gallery-dl's `user`
extractor, which emits a single **Queue** row (type 6) handing the timeline URL
onward, and exits 0. `profileUrl()` therefore always appends an explicit suffix,
and `syncProfile` treats "queue rows and no items" as an error rather than as an
empty timeline.

**An error is not an error exit.** A refused timeline comes back as exit code 0,
empty stderr, and `[-1, {"error": "AuthRequired", ...}]` on stdout. Checking the
exit code reports "0 posts, fine" for a profile that said no. `parseDumpJson`
returns `errors` separately and `syncProfile` throws on it.

**Only Posts works without cookies.** gallery-dl fetches a guest token by itself,
which is enough for `/timeline` and `/tweets`. `/with_replies`, `/media` and
`/likes` return `AuthRequired` without a logged-in session. The settings
dropdowns label these, and `explain()` says which setting fixes it.

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

## Where notes go

Two settings, each with the same five-mode dropdown the other ARCH plugins use
for folders. The vocabulary is shared on purpose; the **anchor** is what differs:

- A **profile note** is placed relative to the archive root, so its modes are
  `vault | root | subfolder | specified | perProfile`.
- A **post note** is placed relative to *its own profile note*, so `same` and
  `subfolder` mean something there and `root` does not:
  `vault | same | subfolder | specified | perProfile`.

Defaults are `Twitter/Profiles` and `Twitter/Posts`. Both accept `{{handle}}`,
`{{author}}`, `{{date}}`, `{{year}}` and `{{month}}`; the date tokens are
evaluated at sync time, not from the post, because a folder that moved when an
old post was backfilled would scatter one profile across several trees.

The settings tab prints the resolved paths for a sample handle. Two folder
settings with five modes each is easy to get wrong silently, and a wrong one
writes hundreds of notes into the wrong place before anyone notices.

## Coupling to ARCH After Clipping — READ THIS

**After Clipping processes every note this plugin writes, and it is expensive.**
Observed on the first Obsidian run: After Clipping picked up each new post note,
read its `url` from raw frontmatter, and ran a full yt-dlp metadata probe against
`x.com/<user>/status/<id>` — about **3 seconds per note** — then actually
downloaded a video and extracted an mp3 into `X/Profiles/@AnhPhuNguyen1/Medias/`.

At the intended scale, 150 profiles × 200 posts, that is a yt-dlp process per
post and tens of thousands of probes nobody asked for.

After Clipping already has the mechanism to avoid this: `otherArchKeys`, which
makes it skip any note carrying one of the named frontmatter keys. Its default is
now `['yt-playlist', 'dl-all', 'x-author', 'x-name']`, and its `loadSettings`
appends missing markers to a *saved* list rather than replacing it — a saved list
would otherwise shadow the default and keep the probing going.

**`x-author` and `x-name` are therefore load-bearing across two plugins.** They
are on both note types here for that reason. Renaming either one, or dropping it
from `postNoteOrder` / `profileNoteOrder`, silently restarts the yt-dlp storm —
and the symptom appears in After Clipping's log, not this one.

`x-post-id` and `x-profile-id` are *not* part of that contract and are planned
for removal. `buildPostIndex` therefore indexes a note by its `x-post-id` **and**
by the id parsed out of its `url`, so de-duplication survives their removal. Do
not reduce that to a single key without checking what the notes on disk carry.

## Rate limiting, which is the real constraint

X rate-limits an authenticated session aggressively, and 150 profiles is a lot of
requests. Three settings exist for this and all three matter:

- `sleepRequest` (`--sleep-request`) — the most effective one
- `maxPerProfile` (`--post-range 1-N`) — fetch recent posts, not whole timelines
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
- **Post note templates.** The frontmatter and body are a first guess. The
  archiving strategy this feeds — what an AI assistant should be able to do with
  a few thousand archived posts — has not been decided yet, and the template
  should not be polished until it has.
- **Only one profile has been run, at five posts.** The claims above are measured
  against gallery-dl 1.32.11 and a live `x.com/naval` timeline: URL forms, message
  types, `--post-range`, the in-band error, the guest token, and the id rounding.
  What has *not* been exercised: a large `--post-range`, the download archive,
  rate limiting under 150 profiles, protected accounts, threads, or any of this
  running inside Obsidian rather than through `lib/` in Node.

  Since updated: enumeration and note writing have now run inside Obsidian across
  several profiles with cookies from Chrome, and worked.
