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

**`x-author` and `x-name` are therefore load-bearing across two plugins.**

Since the profile template was slimmed, they are no longer both on both note
types: a post note carries `x-author` and `x-name`, a **profile note carries only
`x-name`** — `x-author` was dropped from `profileNoteOrder` because on a profile
note it restates the title. `otherArchKeys` matches on *any* of its names, so one
marker is enough.

But it means **`x-name` is the only thing keeping After Clipping off profile
notes.** Removing it from `profileNoteOrder`, or renaming it, restarts the yt-dlp
storm for every profile note, and the symptom appears in After Clipping's log
rather than this one. The 27 hand-made notes are covered by the same property,
which is why they were renamed from `name` to `x-name`. Renaming either one, or dropping it
from `postNoteOrder` / `profileNoteOrder`, silently restarts the yt-dlp storm —
and the symptom appears in After Clipping's log, not this one.

`x-post-id` and `x-profile-id` are *not* part of that contract and are planned
for removal. `buildPostIndex` therefore indexes a note by its `x-post-id` **and**
by the id parsed out of its `url`, so de-duplication survives their removal. Do
not reduce that to a single key without checking what the notes on disk carry.

## What the profile template is for

A profile note is an **anchor to link to from other notes**, not a statistics
page. Follower and post counts were dropped for that reason: filtering is done by
`t-rank`, a hand-assigned subjective ranking, not by counts the plugin could
fetch. So the plugin's job on a profile note is the identity and the images, and
then to stay out of the way of the human's own properties.

That is the reasoning behind the default `url, icon, banner, t-rank, x-name,
tags`. `t-rank` is named although this plugin never produces it — naming it is
what positions it when the existing note carries one.

`urlAsLink` covers the last difference from the hand-made notes: they write
`url` as `[Link](https://x.com/…)` rather than a bare URL. It is a setting rather
than a guess because a sync overwrites whichever form the note already had.

## `x-author` is a link, and it is built from the author

On a post note `x-author` is a **wikilink to the author's profile note**,
`[[@AnthropicAI]]`, not a bare handle. One property both names the author and
gets you there. It replaced a pair that said the same thing twice: a bare
`x-author` string beside an `x-profile` link.

**It is built from `author`, never from the profile being synced.** A quoted post
sitting on someone's timeline was written by someone else, and handing it the
synced profile's link credits the wrong person — the same `author` vs `user`
trap as everywhere else, except that here it would be silently wrong in a
property a human reads. `x-profile` still exists and still means *the timeline it
was found on*; it is simply not in the default order.

The target note often will not exist — an unresolved link to an unarchived
account is correct, and still useful.

`x-name` is not on post notes for the same reason: the display name is one click
away in the profile note. It remains the only After Clipping marker on **profile**
notes, where `x-author` was dropped.

## The order setting is the whole template contract

`postNoteOrder` and `profileNoteOrder` decide **what is written at all**, not just
the sequence. A property this plugin produces that is not on the list is
**dropped**. That is how the note is slimmed to the properties actually wanted,
and it is why `x-profile-id`, `following` and `verified` stopped appearing without
any code change.

This is deliberately *different* from what a name on the list but not produced
does — that is simply skipped — and different again from a property found on the
**existing note**, which is never the plugin's to delete. See below.

**A profile note is rewritten on every sync, and that used to destroy hand-added
properties.** `vault.modify` replaced the whole file, so `t-rank: 5. Mentor` — a
human judgement no sync can reconstruct — and any hand-written body were gone on
the next run. It never actually bit, because the 27 hand-made notes had not been
synced yet, but syncing one would have.

`splitNote()` now reads the existing note first and keeps each property as its
**raw lines** rather than parsing and re-serialising, so a value this code does
not understand survives byte for byte. A kept property named in the order list is
written at that position; one that is not is appended after the ordered part. An
existing non-empty body is preserved as-is — a bio refresh is worth less than
whatever a human wrote under it.

## Settings migrations must persist

`loadSettings` compares the settings it built against what was on disk and saves
when they differ. Without that, a migration ran **in memory on every load and
never reached `data.json`**, so the settings tab showed one thing and the file
said another until an unrelated change triggered a save. That is exactly what
happened with the `x-author-name` → `x-name` rename: it worked at runtime, and
`data.json` kept the old string for days.

Because the order list now decides whether a property is written at all, adding a
property to the plugin means **inserting it into a saved order string** — leaving
it to be appended is no longer harmless, and leaving it out drops it. That
insertion happens after `url`, which every order string starts with.

One migration to be careful with: the 0.1.0 layout migration reproduces the old
`X/Profiles` folders exactly, on purpose, so an upgrade does not silently move
files. For this vault that was the wrong answer — the whole point of the change
was to move to `Twitter/` — and `data.json` was edited by hand to the new
defaults instead. Both behaviours are defensible; the migration is right for
someone with an established archive and wrong for someone who wants the new
layout, and there is no way to tell those apart from inside `loadSettings`.

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

## The profile note this is aiming at

The ~27 hand-clipped profile notes in `TESTFIELD/Twitter/Profiles/` are the real
target. This plugin does not yet produce them. One, in full:

```yaml
url: "[Link](https://x.com/karpathy)"
icon: "[[@karpathy Icon.webp|Icon]]"
banner: "[[@karpathy Banner.webp|Banner]]"
t-rank: 5. Mentor
x-name: Andrej Karpathy
tags:
  - twitter-profile
```

Four differences from what `renderProfile` writes, none of them yet reconciled:

- **`icon` and `banner`** — **built, see below.**
- **`url` is a markdown link**, `"[Link](https://x.com/karpathy)"`, not a bare
  URL. Anything parsing `url` back out has to cope with both forms.
- **`t-rank`** is a hand-assigned ranking. A sync must never overwrite it, which
  is a good reason for the "never rewrite an existing note" rule to stay.
- **`tags` is `twitter-profile`**, not the `x-profile` default here.

The frontmatter *order* settings already exist, so matching this is mostly a
matter of names, plus the image download. Do not "fix" the plugin's defaults to
match this template without checking: the archiving strategy these notes feed has
not been decided yet, and that decision drives the template.

## Profile picture and header

Downloaded on every sync, written into the note's `icon` and `banner` properties
as aliased wikilinks, matching the hand-made notes exactly. Defaults put them in
`Twitter/Profiles/Images` as `@handle Icon.webp` / `@handle Banner.webp` — the
same names the 27 existing notes use, so a first sync of those profiles reuses
what is already on disk and downloads nothing.

**The URLs cost nothing.** gallery-dl's metadata carries `profile_image` and
`profile_banner` on every row, so no extra request is needed to find them. Two
measured details, both in `profileImageUrls()`:

- `profile_image` is **already** the full-size URL. gallery-dl strips the
  `_normal` suffix itself — that variant is a 1.8 KB thumbnail against 25 KB for
  the real one. The strip in the code is belt-and-braces for any extractor that
  does not. *(An earlier version of this file claimed the opposite. It was wrong.)*
- `profile_banner` is a **base** URL and serves a small image on its own: 21 KB
  bare, 81 KB with `/1500x500` appended. **Both return 200**, so getting this
  wrong fails silently as a blurry header rather than as an error.

**Whether an image is already here is decided by looking for the file**, under
any extension it might carry — not by a property, and not by assuming `.webp`.
One of the existing profiles has a `.png` icon where every other has `.webp`;
checking only the target extension would re-download it on every sync forever.
Same discipline as ARCH YT Playlists' download check, and the reason re-running
150 profiles does not re-fetch 300 images.

`refreshProfileImages` exists to pick up a changed avatar and is **off** by
default. It re-downloads all of them, which is the expensive path.

A failure here never fails the sync — a missing avatar is not a reason to lose a
profile's posts — so each image is caught separately and logged.

`requestUrl` is used rather than `fetch`: it is Obsidian's own client, so it is
not subject to the renderer's CORS rules and follows redirects.

`lib/image.js` is the one file in `lib/` that **cannot run under plain Node** — it
uses `OffscreenCanvas`, which exists only in the renderer. Requiring it there is
fine; calling `encodeWebp` is not.

## The test vault, and one piece of stale state

`TESTFIELD` (`~/Downloads/TESTFIELD`) is where this runs. The plugin is
**symlinked** there from `~/Documents/arch-x-archive` rather than copied, so
editing the repo and reloading Obsidian picks the change up with no build step.

**There are ~165 notes under `X/Profiles/` from before the folder settings
existed**, written by 0.1.0 under the old `X/Profiles` default and still carrying
`x-author-name` instead of `x-name`. The plan is to delete `X/` and re-sync into
the `Twitter/Profiles` and `Twitter/Posts` defaults; it had not been done at the
time of writing. Do not treat those notes as evidence of current behaviour, and
check whether `X/` still exists before concluding anything from what is on disk.

Enumeration has run there against several real profiles with cookies from Chrome
and worked. Never exercised: the setup modal's install button, the bulk-add
modal, `promptForUrl`, and every folder mode other than the default.

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
