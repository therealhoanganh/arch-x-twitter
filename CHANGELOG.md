# Changelog


## 0.3.0 — unreleased

- **The profile picture and header are downloaded**, saved beside the profile
  note and written into its `icon` and `banner` properties as aliased wikilinks.
  Defaults reproduce the layout the hand-made notes already use:
  `Twitter/Profiles/Images/@handle Icon.webp` and `… Banner.webp`.
- The URLs come free — gallery-dl's metadata carries `profile_image` and
  `profile_banner` on every row — so this costs two downloads per profile and no
  extra API calls.
- Where the images go is a five-mode setting like the others, anchored on the
  profile note. File names are templates.
- Downloaded JPEG is converted to WebP, roughly halving it. An image that would
  come out larger keeps its original format.
- **An image already on disk is left alone**, found by looking for the file under
  any extension rather than by trusting a property or assuming `.webp` — one
  existing profile has a `.png` icon. `refreshProfileImages`, off by default,
  forces a re-download.
- A failed image never fails the sync.

Two measured details that are easy to get wrong: `profile_image` is already the
full-size URL, and `profile_banner` is a base URL that needs `/1500x500`
appended — the bare form returns 200 and a small image, so the mistake shows up
as a blurry header, not an error.

## 0.2.0 — unreleased

- **Note folders now use the five-mode dropdown the other ARCH plugins use**,
  once for profile notes and once for post notes, replacing the single
  `archiveRoot` path and the per-profile-folder toggle. The anchor differs by
  kind: a profile note is placed relative to the archive root, a post note
  relative to its own profile note, so `same` and `subfolder` mean something for
  posts. Both accept `{{handle}}`, `{{author}}`, `{{date}}`, `{{year}}` and
  `{{month}}`.
- Defaults are now `Twitter/Profiles` and `Twitter/Posts`.
- The settings tab prints the resolved paths for a sample handle, because two
  folder settings with five modes each is easy to get wrong silently.
- A 0.1.0 config migrates: the old `archiveRoot` becomes the profile folder, the
  per-profile toggle becomes `perProfile`, and post notes stay beside their
  profile note.

- **`x-author-name` is now `x-name`.** A saved frontmatter order string naming
  the old key is migrated, so the property does not silently fall to the bottom.
- Post notes are indexed for de-duplication by `x-post-id` **and** by the id
  parsed out of their `url`, so dropping `x-post-id` from the template later does
  not start creating duplicates.

### Found by the first Obsidian run

- **ARCH After Clipping processes every note this plugin writes.** It read each
  post note's `url` and ran a yt-dlp metadata probe — ~3s per note — and
  downloaded media into the profile folder. At 150 profiles that is tens of
  thousands of unwanted probes. Fixed in After Clipping: `x-author` and `x-name`
  are now in its `otherArchKeys` default, and a saved list gets missing markers
  appended rather than shadowing the default. Those two properties are now a
  contract between the two plugins.

## 0.1.0 — unreleased

First scaffold. Enumeration and note writing work and have been run against a
live timeline; media download does not exist yet.

**Found by the first live run, against gallery-dl 1.32.11**

Six things were wrong in the doc-derived first draft. Each is now measured:

- **Tweet ids were being rounded away.** 19-digit snowflake ids exceed
  `Number.MAX_SAFE_INTEGER`, so `JSON.parse` turned `…918` into `…920` and every
  post URL 404'd. Id-shaped fields are quoted in the raw text before parsing and
  are strings everywhere afterwards.
- **`--range` limits files, not posts.** `--range 1-3` returned 3 media files and
  66 posts. Switched to `--post-range`.
- **A bare `x.com/<name>` returns a Queue row and no posts.** Timeline URLs are
  now explicit, and a queue-only result is an error rather than an empty result.
- **Text-only posts produce no `Url` row**, only a `Directory` row — 66 posts on
  one timeline gave 66 Directory rows and 3 Url rows. Both types are read.
- **Errors arrive in-band**: exit 0, empty stderr, `[-1, {error, message}]` on
  stdout. Parsed and thrown properly instead of being read as "0 posts, fine".
- **Posts works without cookies** via gallery-dl's guest token; replies, media and
  likes return `AuthRequired`. The dropdowns and error text now say so.

**Fetching**
- `gallery-dl` does the fetching, in the same shape as ARCH YT Playlists: the
  external tool enumerates, this plugin owns notes and the queue.
- Cookies from a detected browser at run time, or a `cookies.txt` file. Nothing
  is stored by the plugin.
- Per-profile timeline choice: posts, with-replies, media only, or likes.
- `--config-ignore` on every call, so a user's own `~/.config/gallery-dl` cannot
  silently change what the settings tab says.

**Profiles**
- A profile list with per-entry timeline, tags and an enable toggle.
- Bulk add by pasting handles or URLs, one per line — built for the 150-profile
  list this exists for.
- Sync all, or sync one from its row in settings.

**Notes**
- One note per post, one note per profile, optionally in a folder per profile.
- Frontmatter order is a setting; a name not on the list is appended rather than
  dropped, so a hand-added property survives.
- Post identity is `x-post-id`, not the filename, so a post found on two
  timelines is not written twice and changing the name template does not create
  duplicates.
- An existing post note is never rewritten: like counts change constantly and
  refreshing them would churn the whole archive on every sync.

**Setup**
- First-run detection of gallery-dl, Python 3, ffmpeg and browsers, with the
  found paths filled in automatically.
- `Install gallery-dl` builds a private venv inside the plugin folder. gallery-dl
  publishes no prebuilt binaries — verified against the last eight releases — so
  the yt-dlp standalone-download approach does not transfer.

**Rate limiting**
- `--sleep-request`, `--range 1-N` per profile, and an optional download archive
  so re-runs are cheap.
- 401, 429 and 404 are reported with the fix rather than as raw stderr.
