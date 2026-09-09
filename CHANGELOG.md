# Changelog

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
