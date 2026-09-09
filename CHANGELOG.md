# Changelog










## 0.10.0 — unreleased

- **Profiles are now two lists.** A handful of accounts keep their own row with
  their own options; the long tail lives in a textarea sharing one set of
  options. Hundreds of rows made the settings tab slow to open and impossible to
  search, and there is nothing per-profile worth configuring for most of them.
- The bulk list is behind a disclosure that remembers whether it was open, saves
  on a debounce rather than per keystroke, and re-renders only on blur.
- It accepts `@handle`, a bare handle or a full URL, and ignores blank lines and
  lines starting with `#`, so the list can carry its own notes.
- A handle in both lists is synced once; the row wins, since it carries the
  deliberate settings.
- Rows gain a **move to the bulk list** button, so promoting and demoting an
  account is one click.
- **Profile notes can be created without archiving any posts** — a button in each
  section and a per-row one, plus a command. Adding someone so you can link to
  them should not mean archiving their timeline. The download archive is skipped
  in that mode so a later real sync does not miss the post that was fetched for
  its author block.
- New commands: sync individual only, sync the bulk list only, create profile
  notes only.

## 0.9.0 — unreleased

- **Template and folder changes now actually reach a vault that has already run
  the plugin.** Saved settings shadow defaults, so every template change since
  0.4.0 — the slimmed profile and post templates, `shared-by`, the tag rename,
  the `Twitter/` layout — was being silently overridden by an old `data.json`.
  The code was right; the settings were winning.
- `TEMPLATE_SETTINGS` names the settings that describe what the plugin writes
  rather than a preference someone tuned, and `settingsVersion` resets exactly
  those once per bump. Profiles, cookies, limits and binary paths are untouched.
- New **Reset templates and folders** button in settings, for doing it by hand.
- `loadSettings` now logs the resolved profile folder and both templates, so what
  is in force is visible rather than inferred.
- `retweets` now defaults to on.

## 0.8.1 — unreleased

- **Reloading the plugin now actually reloads `lib/`.** Electron's `require()`
  caches by resolved path and a disable/enable does not clear it, so editing
  anything in `lib/` and reloading kept running the old code — while `main.js`
  edits took effect, which made it look like changes were randomly not saving.
  Only a full app reload worked. The cache entries are now dropped before
  requiring, matching the plugin folder and its realpath, since during
  development it is a symlink into the repo.

## 0.8.0 — unreleased

Found by turning reposts on and following the links.

- **A repost's URL pointed at the wrong tweet.** On a repost `tweet_id` is the
  repost and `retweet_id` is the original, so `x.com/<author>/status/<tweet_id>`
  paired one account's handle with another's id. X answered 307 and redirected to
  the reposter, so the link worked and quietly went to the repost rather than the
  post. `canonicalId()` now picks `retweet_id` when there is one; all five repost
  URLs from a live timeline resolve directly with no redirect.
- **De-duplication uses the original's id**, so one post reposted by several
  archived profiles is one note rather than one per reposter. Grouping still keys
  on `tweet_id`, which is what a post's media rows share.
- **`RT @handle: ` is stripped from the body and the filename.** It repeated what
  `x-author` and `shared-by` already say. The original's full text is kept.
- Noted for anyone reading the metadata: `retweet_id` is a numeric `0` on
  non-reposts, not absent, and not the string `"0"`.

## 0.7.0 — unreleased

- **`x-profile` is now `shared-by`**, and it is written only when the post is not
  the profile owner's own. A reposted note reads `x-author: [[@AnthropicAI]]`
  beside `shared-by: [[@Hesamation]]` — who wrote it, and who put it in front of
  you. On someone's own post the property is absent rather than saying they
  shared themselves.
- Handle comparison is case-insensitive: X is not consistent about capitalisation
  between the author field and the timeline the post came from.
- **Tags are now `x-twitter-post` and `x-twitter-profile`** (were `x-post` and
  `x-profile`).

## 0.6.0 — unreleased

- **`x-author` on a post note is now a wikilink to the author's profile note.**
  One property that both names the author and gets you there, replacing a bare
  `x-author` string beside a separate `x-profile` link that said the same thing.
- It is built from the post's **author**, not from the profile being synced.
  Handing it the synced profile's link would credit a quoted post to the wrong
  person — the `author` vs `user` trap, this time in a property a human reads.
  `x-profile` still exists and still means the timeline the post was found on.
- Post template default is now `url, x-author, published, media, tags`.
  `x-name` is gone: the display name is one click away in the profile note.
- **`url` is written as a markdown link by default**, `[Link](https://x.com/…)`,
  matching the hand-made notes.

## 0.5.0 — unreleased

- **The profile template is slimmed to what a profile note is for**: an anchor to
  link to, not a statistics page. Default is now
  `url, icon, banner, t-rank, x-name, tags`. Follower and post counts are gone —
  filtering is done by the hand-assigned `t-rank`, not by counts.
- `t-rank` is named in the default order although the plugin never produces it,
  which is what positions a hand-added one rather than appending it.
- **`x-author` is dropped from profile notes**, where it only restated the title.
  It stays on post notes. That makes `x-name` the only marker keeping ARCH After
  Clipping off profile notes; `otherArchKeys` matches any one name, so this is
  fine, but removing `x-name` too is not.
- New setting: **write `url` as a markdown link**, `[Link](https://x.com/…)`,
  matching the hand-made notes. Off by default. A sync overwrites whichever form
  a note already had, so it is a setting rather than a guess.

## 0.4.0 — unreleased

Three bugs, all found by the first sync that actually wrote notes.

- **A profile note rewrite no longer destroys hand-added properties.** The note
  was replaced wholesale on every sync, so `t-rank` — a human judgement no sync
  can reconstruct — and any hand-written body would have been lost the first time
  one of the 27 existing profiles was synced. The existing note is now read first
  and each unknown property carried over as its raw lines. An existing non-empty
  body is kept.
- **The frontmatter order setting now decides what is written**, not just the
  sequence: a property the plugin produces that is not on the list is dropped.
  `x-profile-id`, `following`, `verified` and `lang` stop appearing. A hand-added
  property named in the list is written at that position rather than appended.
- **Settings migrations are saved.** They ran in memory on every load and never
  reached `data.json`, so the `x-author-name` → `x-name` rename worked at runtime
  while the file kept the old string. A saved order string also now gains
  properties added since it was written — necessary, because an absent name is
  now a deletion rather than an append.

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
