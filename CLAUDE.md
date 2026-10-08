# ARCH X Twitter

## Rules

### What It Is

- An Obsidian plugin that archives X/Twitter profiles and single posts into the vault as notes, in bulk, through `gallery-dl`.
- Shaped like YT Playlists on purpose: an outside tool fetches, the plugin owns the listing, the notes and the queue.
- gallery-dl with browser cookies, because X has no free timeline API and gallery-dl is kept up against X's changes by others.
- Installed only in CHAOS, TECHNOS and `~/Documents`, his choice. Never add it elsewhere.
- Read `CHANGELOG.md` before changing behaviour. It records why each thing is the way it is.
- The old file word for word, with the measurements: `Documents/_/AI/arch-x-twitter/Details.md`.

### gallery-dl

- gallery-dl publishes no prebuilt binaries. `installGalleryDl()` builds a private venv at `bin/venv`. Never restore a binary download.
- A venv hardcodes its own absolute path. After a plugin or vault rename it fails with "bad interpreter" and must be recreated, not moved.
- `ensureGalleryDl()` checks the binary once per session and looks again if it will not run.
- A renamed vault leaves no working copy to find. Recreate the venv in place (`python3 -m venv --clear`, then `pip install gallery-dl`) and point `galleryDlPath` at it, at once.
- `bin/venv` is not mirrored. Each computer builds its own, and `galleryDlBin()` prefers it over the synced `galleryDlPath`.
- On the PC, venvs are made with `uv venv` and `uv pip install gallery-dl secretstorage`. Set Up External Tools falls back to `uv`.
- `--config-ignore` goes on every call, so his own gallery-dl config never overrides the settings tab.

### Reading What gallery-dl Returns

- X's ids are 19 digits and `JSON.parse` rounds them. `quoteBigIds()` turns id fields into strings before parsing. Every id is a string from then on. Never compare one with `==` against a `Number()`.
- A text-only post arrives as a Directory row (type 2). Only media make Url rows (type 3). Reading Url rows alone drops almost every post.
- `--post-range` limits posts. `--range` limits files. "Most recent N posts" uses `--post-range`.
- A bare `x.com/<name>` returns one Queue row (type 6) and no posts. `profileUrl()` always adds a suffix, and "queue rows and no items" is an error.
- A refused timeline exits 0 with `[-1, {"error": "AuthRequired", ...}]` on stdout. `parseDumpJson` returns errors apart, and `syncProfile` throws on them.
- Without cookies only Posts works. Replies, Media and Likes need a login. `explain()` says which setting fixes it.
- `author` wrote the post, `user` owns the timeline it was found on. `authorOf()` prefers `author`; keep it.
- One post can give several Url rows, one per photo. `groupByTweet()` folds them by `tweet_id`.

### Reposts

- A repost row holds two tweets: `tweet_id` is the repost, `retweet_id` the original.
- `x.com/<author>/status/<tweet_id>` does not fail. X redirects it to the repost, silently.
- `canonicalId()` is `retweet_id` when there is one, else `tweet_id`. It is the URL, `x-post-id`, the name's `{{id}}` and the de-duplication key. Grouping still keys on `tweet_id`.
- So one original reposted by several archived profiles is one note.
- `retweet_id` is the number 0 on a non-repost. The check reads `rt && String(rt) !== '0'`.
- A repost's `content` starts `RT @handle: `. `expandUrls` strips it.

### Post Notes

- An existing post note is never rewritten. Like counts change constantly, and rewriting would flood the vault's git history.
- Identity is `x-post-id`, not the file name, so a new name template makes no duplicates.
- `buildPostIndex()` runs once per sync and is updated as notes are written. The cache has not seen a note made moments earlier.
- It indexes by `x-post-id` and by the id in `url`, so `x-post-id` can be removed later. Never reduce it to one key without checking the notes on disk.
- `x-author` is a wikilink to the author's profile note, built from `author`, never from the profile being synced.
- `shared-by` names the profile only when the post is not its owner's own: a repost or a quote. Handles are compared ignoring case.
- An unresolved `x-author` link to an unarchived account is correct.

### Profile Notes

- A profile note is an anchor to link to, not a statistics page. No follower or post counts.
- He ranks profiles by hand with `t-rank`. A sync never touches it.
- The default order is `url, icon, banner, t-rank, x-name, tags`. `t-rank` is named so it keeps its place.
- `urlAsLink` writes `url` as `[Link](https://x.com/…)`, like his hand-made notes.
- A profile note is rewritten on every sync. `splitNote()` keeps every existing property as its raw lines, and keeps a non-empty body as it is.
- `syncProfile(profile, { profileOnly: true })` writes the profile note and images, no posts. One post is still fetched for the author block, and the download archive is skipped so a later sync does not miss it.
- Icon and banner go in `Twitter/Profiles/Images` as `@handle Icon.webp` and `@handle Banner.webp`, as aliased wikilinks.
- `profile_image` is already full size. `profile_banner` needs `/1500x500`, or it is a small image, and both return 200.
- Whether an image is here is decided by looking for the file under any extension, never by a property.
- `refreshProfileImages` is off by default. It downloads every image again.
- An image failure never fails the sync. Each is caught and logged.
- `lib/image.js` uses `OffscreenCanvas`, so `encodeWebp` cannot run under plain Node.

### After Clipping

- After Clipping processes every note with a `url` and sends x.com posts to yt-dlp, about 3 seconds each.
- `x-author` and `x-name` keep it off. They are in its `otherArchKeys`.
- A post note carries both. A profile note carries only `x-name`, which is all that keeps After Clipping off it.
- Renaming either, or dropping one from `postNoteOrder` or `profileNoteOrder`, restarts the probing. The symptom shows in After Clipping's log, not here.
- `x-post-id` and `x-profile-id` are not part of that contract.

### Where Notes Go

- Two folder settings, each with the family's five modes. A profile note is placed from the archive root (`vault | root | subfolder | specified | perProfile`), a post note from its profile note (`vault | same | subfolder | specified | perProfile`).
- Defaults: `Twitter/Profiles` and `Twitter/Posts`. Date tokens are evaluated at sync time, so a backfill never scatters one profile.
- The settings tab prints the resolved paths for a sample handle. A wrong folder writes hundreds of notes before anyone notices.

### The Order Settings Decide What Is Written

- `postNoteOrder` and `profileNoteOrder` decide what is written. A property the plugin makes that is not listed is dropped.
- A listed name the plugin does not make is skipped. A property already on the note is never the plugin's to delete.
- Adding a property to the plugin means inserting it into saved order strings, after `url`.

### Settings

- Saved settings win over defaults. `TEMPLATE_SETTINGS` lists the settings that describe what is written, and `loadSettings` resets them once per `settingsVersion` bump.
- Profiles, cookies, rate limits and tool paths are never reset.
- Reset Templates and Folders does it by hand.
- `loadSettings` saves when its result differs from the file, so a migration reaches `data.json`.
- `loadSettings` logs the profile folder and both templates on every load.
- The 0.1.0 layout migration keeps the old `X/Profiles` folders, on purpose, for an established archive.

### Two Lists

- `profiles` is a few accounts, each a row with its own settings. `bulkList` is the long tail, hundreds of handles as text.
- The bulk list is edited in a popup behind Manage… (`ListModal`, the same class as the others). It saves on Save, or on closing with an edit in it. Only Cancel discards.
- It takes `@handle`, a bare handle or a URL, skips blank lines and ignores lines starting with `#`.
- A handle in both lists syncs once, and the row wins (`allProfiles()`).

### Rate Limits and Cookies

- X rate-limits a logged-in session hard. `sleepRequest`, `maxPerProfile` and `useDownloadArchive` all matter.
- A 429 is reported through `explain()` with the fix.
- Cookies are read from the browser at each run (`--cookies-from-browser`). The plugin stores none.
- Safari is tried last: its cookies need Full Disk Access, which fails like a login problem.
- `data.json` holds the cookie source and the profile list, so it is gitignored.
- On the PC, Chrome's cookies depend on the GNOME keyring. Set Up External Tools tests them and names a broken keyring.
- For a broken keyring, advise a restart. A log out and back in once ended in NVIDIA errors and a reset PC.

### Building and Releasing

- `npm run build` writes `dist/main.js` and `dist/manifest.json`. Check a release in a folder with no `lib/`.
- `lib()` takes `ARCH_LIB` when the build defined it, else reads `lib/` from disk. Keep both.
- `dropLibFromRequireCache()` clears the plugin folder and its real path from `require.cache`.
- Rewriting history means moving every tag too. The steps: `Details.md`, Rewriting History Means Repointing Every Tag.

## Mistakes and Lessons

- The first live run: every post link was a 404, because `JSON.parse` rounded the ids.
- The first Obsidian run: After Clipping probed each new post note and downloaded a video and an mp3.
- Changing defaults did nothing in a vault with saved settings. Four rounds of work looked unapplied.
- Editing `data.json` while Obsidian ran was reverted by the plugin and wasted a round of debugging.
- A migration ran only in memory. `data.json` kept `x-author-name` for days.
- A profile sync would have erased `t-rank` and his body text. It never bit, because the hand-made notes had not been synced.
- This file once said `profile_image` needed its `_normal` stripped. gallery-dl already does it.
- The plugin rename (`arch-x-archive` to `arch-x-twitter`) and the TECHS to TECHNOS rename broke the venv in TECHNOS and `~/Documents` until Sep 25.
- Sep 27: the PC had no gallery-dl, and the plugin threw `spawn … ENOENT`.
- `findByPostId` once scanned the whole vault per post: 30,000 scans at full scale.

## Where It Stands

- 0.11.10 is current. In CHAOS, TECHNOS and `~/Documents` through BRAT. TESTFIELD has the symlink. Checked Oct 9.
- No vault has a profile in either list, on purpose. TECHNOS has an empty `Twitter/Posts` folder.
- TECHNOS holds 182 hand-made profile notes. 29 carry `name`, not `x-name`, so After Clipping's marker misses them.
	- Harmless while After Clipping's x.com pattern matches only `/status/`.
- TESTFIELD's `Twitter/Profiles` holds one note, `@nickfloats.md`.
- `dropLibFromRequireCache` does not walk `window.require.cache`, the fault Recreations fixed. Untested here.
- Not built:
	- media download. The settings exist, nothing reads them. Copy YT Playlists' rule: the file on disk decides;
	- threads. `conversation_id` is there, nothing groups it;
	- a `/status/` link in Archive an X Post or Profile by URL… is read as a profile;
	- the venv reinstalling itself after a vault rename.
- Archiving waits for the X/Twitter part of his Internet Research System, a smart filter that picks what to keep. His words, Oct 9: "to archive blindly will quickly clutter my vault, we need a smart filter rule, maybe singal identifier skill."
- Leave the post template alone until then. The filter decides the template.
- Never run by a person: the setup popup's install button, the bulk-add popup, the URL prompt and every folder mode but the default.
- Not tried: a large `--post-range`, the download archive, 150 profiles' rate limits, protected accounts.
