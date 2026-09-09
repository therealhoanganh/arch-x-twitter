// gallery-dl argument building and output parsing. Pure -- no Obsidian API and
// no child_process; main.js owns process spawning. See CLAUDE.md on why nothing
// in lib/ may require('obsidian').

// gallery-dl's --dump-json emits one JSON array per item. All four shapes below
// were confirmed against gallery-dl 1.32.11 and a live x.com timeline:
//
//   [-1, {error, message}]           an error, reported IN-BAND -- see below
//   [ 2, {metadata}]                 Message.Directory -- one per POST
//   [ 3, "https://...", {metadata}]  Message.Url       -- one per MEDIA FILE
//   [ 6, "https://...", {metadata}]  Message.Queue     -- a URL to be handled
//                                    by another extractor; carries no post
//
// Two of those are traps:
//
// A TEXT-ONLY TWEET PRODUCES NO Url ENTRY. It arrives as a Directory row only,
// carrying the full metadata including `content`. Reading Url rows alone --
// which is what a media downloader's output looks like it should mean -- drops
// every text post silently. Measured: 66 posts from one timeline produced 66
// Directory rows and 3 Url rows.
//
// AN ERROR IS NOT AN ERROR EXIT. gallery-dl exits 0, writes nothing to stderr,
// and puts `[-1, {"error": "AuthRequired", ...}]` on stdout. Checking the exit
// code reports "0 posts, fine" for a timeline that actually refused the request.
const MSG_ERROR = -1;
const MSG_DIRECTORY = 2;
const MSG_URL = 3;
const MSG_QUEUE = 6;

// X's ids are 19-digit snowflakes -- 1574638443237294081 -- and
// Number.MAX_SAFE_INTEGER is 16 digits. JSON.parse does not fail on those; it
// silently rounds, so 1574638443237294081 becomes 1574638443237294000 and the
// link built from it 404s. Measured against a live timeline: every post URL was
// wrong, and the id used for de-duplication was wrong with it.
//
// There is no JSON.parse option for this, and a reviver is handed the number
// after the damage. So id-shaped fields are quoted in the raw text first, and
// every id in this module is a string from that point on. Do not "tidy" these
// back to numbers.
const BIG_ID_KEYS = /"((?:\w+_)?id)":\s*(\d{16,})/g;

function quoteBigIds(text) {
  return text.replace(BIG_ID_KEYS, '"$1": "$2"');
}

// Returns { items, errors, queued }. `errors` being non-empty means the run
// failed even though the process exited 0.
function parseDumpJson(stdout) {
  const items = [];
  const errors = [];
  const queued = [];
  const text = quoteBigIds(String(stdout || '').trim());
  if (!text) return { items, errors, queued };

  // gallery-dl writes a single pretty-printed array when it can, and a stream of
  // one-per-line arrays when output is large. Try the whole thing first.
  let rows = null;
  try {
    const whole = JSON.parse(text);
    if (Array.isArray(whole)) rows = whole;
  } catch (_) { /* fall through to line mode */ }

  if (!rows) {
    rows = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('[')) continue;
      try { rows.push(JSON.parse(t)); } catch (_) { /* partial line */ }
    }
  }

  for (const row of rows) {
    if (!Array.isArray(row) || !row.length) continue;
    if (row[0] === MSG_ERROR) errors.push(row[1] || { message: 'unknown error' });
    else if (row[0] === MSG_URL && row.length >= 3) items.push({ url: row[1], meta: row[2] || {} });
    else if (row[0] === MSG_QUEUE && row.length >= 2) queued.push(row[1]);
    else if (row[0] === MSG_DIRECTORY && row.length >= 2) items.push({ url: null, meta: row[1] || {} });
  }
  return { items, errors, queued };
}

// One tweet can produce several Url entries -- one per photo or video. They are
// folded back into a single post keyed by tweet_id, with the media collected.
function groupByTweet(items) {
  const byId = new Map();
  for (const item of items) {
    const m = item.meta || {};
    const id = String(m.tweet_id || m.id || ''); // already a string; see quoteBigIds
    if (!id) continue;
    let post = byId.get(id);
    if (!post) {
      post = { id, meta: m, media: [] };
      byId.set(id, post);
    }
    if (item.url && !/^text:/.test(item.url)) {
      post.media.push({
        url: item.url,
        type: m.type || 'photo',
        filename: m.filename || '',
        extension: m.extension || '',
        num: m.num || post.media.length + 1,
      });
    }
  }
  return [...byId.values()];
}

// A BARE PROFILE URL RETURNS ONLY A Queue ROW, never posts: x.com/<name> maps to
// gallery-dl's `user` extractor, which just hands the timeline URL onward. Every
// suffix here is explicit for that reason.
//
// /timeline and /tweets work with the guest token gallery-dl fetches on its own.
// /with_replies and /media do NOT -- they return
// [-1, {"error": "AuthRequired", "message": "authenticated cookies needed..."}]
// unless cookies are configured. Verified against a live timeline.
const TIMELINE_SUFFIX = {
  posts: '/timeline',
  tweets: '/tweets',
  replies: '/with_replies',
  media: '/media',
  likes: '/likes',
};

// Which timelines X refuses without a logged-in session.
const NEEDS_COOKIES = new Set(['replies', 'media', 'likes']);

function profileUrl(handle, which = 'posts') {
  const name = String(handle || '').trim().replace(/^@/, '').replace(/^https?:\/\/(x|twitter)\.com\//i, '').split(/[/?]/)[0];
  if (!name) return null;
  const suffix = TIMELINE_SUFFIX[which] !== undefined ? TIMELINE_SUFFIX[which] : TIMELINE_SUFFIX.posts;
  return `https://x.com/${name}${suffix}`;
}

function handleFromUrl(url) {
  const m = String(url || '').match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([^/?#]+)/i);
  return m ? m[1] : '';
}

// `opts` mirrors the plugin's settings; everything here is a gallery-dl flag, so
// this function is the one place that has to track gallery-dl's CLI.
function buildArgs(target, opts = {}) {
  const args = [];

  if (opts.configFile) args.push('--config', opts.configFile);
  else args.push('--config-ignore'); // never inherit ~/.config/gallery-dl/config.json by accident

  if (opts.cookiesFile) args.push('--cookies', opts.cookiesFile);
  else if (opts.cookiesFromBrowser) args.push('--cookies-from-browser', opts.cookiesFromBrowser);

  // Text-only tweets are skipped entirely without this: gallery-dl is a media
  // downloader first, and a tweet with no image is not media.
  args.push('-o', `extractor.twitter.text-tweets=${opts.textTweets === false ? 'false' : 'true'}`);
  args.push('-o', `extractor.twitter.retweets=${opts.retweets ? 'true' : 'false'}`);
  args.push('-o', `extractor.twitter.replies=${opts.replies ? 'true' : 'false'}`);
  args.push('-o', `extractor.twitter.quoted=${opts.quoted ? 'true' : 'false'}`);
  args.push('-o', `extractor.twitter.videos=${opts.videos === false ? 'false' : 'true'}`);
  if (opts.cards) args.push('-o', 'extractor.twitter.cards=true');

  if (opts.sleepRequest) args.push('--sleep-request', String(opts.sleepRequest));
  // --range limits FILES, not posts: `--range 1-3` on a timeline returned 3 media
  // files and 66 posts. --post-range is the one that caps posts, and it is what
  // "most recent N posts" has to use.
  if (opts.postRange) args.push('--post-range', String(opts.postRange));
  if (opts.range) args.push('--range', String(opts.range));
  if (opts.postFilter) args.push('--post-filter', String(opts.postFilter));
  if (opts.filter) args.push('--filter', String(opts.filter));
  if (opts.archiveFile) args.push('--download-archive', opts.archiveFile);
  if (opts.abortAfter) args.push('--abort', String(opts.abortAfter));

  if (opts.dumpJson) {
    args.push('--dump-json');
    args.push('--no-download');
  } else {
    if (opts.destination) args.push('--destination', opts.destination);
    if (opts.filename) args.push('--filename', opts.filename);
    if (opts.directory != null) args.push('-o', `extractor.twitter.directory=${JSON.stringify(opts.directory)}`);
  }

  for (const extra of String(opts.extraArgs || '').split(/\s+/).filter(Boolean)) args.push(extra);
  args.push(target);
  return args;
}

// Profile picture and header, straight out of the metadata every row already
// carries -- no extra request is needed to find them.
//
// Measured against a live timeline, not assumed:
//   profile_image  is ALREADY the full-size URL. gallery-dl strips the `_normal`
//                  suffix itself; that variant is a 1.8 KB thumbnail against
//                  25 KB for the real one. The strip below is belt-and-braces
//                  for any extractor that does not.
//   profile_banner is a BASE url and serves a small image on its own (21 KB).
//                  Appending a size gives the real header: /1500x500 -> 81 KB.
//                  Both forms return 200, so a wrong one fails silently as a
//                  blurry image rather than as an error.
const BANNER_SIZE = '1500x500';

function profileImageUrls(meta) {
  const a = (meta && (meta.author || meta.user)) || {};
  const icon = a.profile_image ? String(a.profile_image).replace(/_normal(?=\.\w+$)/, '') : '';
  const banner = a.profile_banner ? `${String(a.profile_banner).replace(/\/$/, '')}/${BANNER_SIZE}` : '';
  return { icon, banner };
}

module.exports = {
  profileImageUrls, BANNER_SIZE,
  parseDumpJson, groupByTweet, buildArgs, profileUrl, handleFromUrl,
  TIMELINE_SUFFIX, NEEDS_COOKIES, MSG_ERROR, MSG_URL, MSG_DIRECTORY, MSG_QUEUE,
  quoteBigIds,
};
