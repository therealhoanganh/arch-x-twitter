# Changelog

## 0.1.0 — unreleased

First scaffold. Enumeration and note writing work; media download does not exist
yet. Nothing here has been run against a real X timeline.

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
