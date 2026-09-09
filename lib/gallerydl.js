// gallery-dl argument building and output parsing. Pure -- no Obsidian API and
// no child_process; main.js owns process spawning. See CLAUDE.md on why nothing
// in lib/ may require('obsidian').

// gallery-dl's --dump-json emits one JSON array per item, of the shape
//   [2, {directory metadata}]        Message.Directory
//   [3, "https://...", {metadata}]   Message.Url
// A text-only tweet still produces a Url entry, because text-tweets synthesises
// a text/plain "url" for it. Anything else (version banners, queue entries) is
// ignored rather than treated as an error.
const MSG_DIRECTORY = 2;
const MSG_URL = 3;

function parseDumpJson(stdout) {
  const items = [];
  const text = String(stdout || '').trim();
  if (!text) return items;

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
    if (row[0] === MSG_URL && row.length >= 3) items.push({ url: row[1], meta: row[2] || {} });
    else if (row[0] === MSG_DIRECTORY && row.length >= 2) items.push({ url: null, meta: row[1] || {} });
  }
  return items;
}

// One tweet can produce several Url entries -- one per photo or video. They are
// folded back into a single post keyed by tweet_id, with the media collected.
function groupByTweet(items) {
  const byId = new Map();
  for (const item of items) {
    const m = item.meta || {};
    const id = String(m.tweet_id || m.id || '');
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

const TIMELINE_SUFFIX = {
  posts: '',
  replies: '/with_replies',
  media: '/media',
  likes: '/likes',
};

function profileUrl(handle, which = 'posts') {
  const name = String(handle || '').trim().replace(/^@/, '').replace(/^https?:\/\/(x|twitter)\.com\//i, '').split(/[/?]/)[0];
  if (!name) return null;
  return `https://x.com/${name}${TIMELINE_SUFFIX[which] || ''}`;
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
  if (opts.range) args.push('--range', String(opts.range));
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

module.exports = { parseDumpJson, groupByTweet, buildArgs, profileUrl, handleFromUrl, TIMELINE_SUFFIX, MSG_URL, MSG_DIRECTORY };
