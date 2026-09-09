// Turning gallery-dl's tweet metadata into note text. Pure string work; the
// caller supplies media links it has already resolved to vault paths.

const { sanitizeName } = require('./naming.js');

// gallery-dl gives `date` as "YYYY-MM-DD HH:MM:SS" in UTC.
function isoDate(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return s;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function isoDateTime(raw) {
  const s = String(raw || '').trim().replace(' ', 'T');
  return /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) ? s.slice(0, 19) + 'Z' : s;
}

// `author` is who wrote the tweet; `user` is whose timeline it was found on.
// They differ on a retweet, and using the wrong one files someone else's words
// under your subject's name.
function authorOf(meta) {
  const a = meta.author || meta.user || {};
  return { nick: a.nick || a.name || '', name: a.name || '', id: a.id || '' };
}

function tweetUrl(meta) {
  const a = authorOf(meta);
  const id = meta.tweet_id || meta.id;
  return a.name && id ? `https://x.com/${a.name}/status/${id}` : '';
}

function expandUrls(text, meta) {
  // gallery-dl already expands t.co links in `content` when it can. What is left
  // is the trailing t.co pointing at the tweet's own media, which is noise.
  return String(text || '').replace(/\s*https:\/\/t\.co\/\w+\s*$/g, '').trim();
}

function quoteBlock(text) {
  return String(text || '').split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');
}

// Splitting an existing note into its frontmatter blocks and body, keeping the
// raw text of each property.
//
// This exists because a profile note is REWRITTEN on every sync, and the notes
// this has to live alongside carry hand-added properties -- `t-rank: 5. Mentor`
// is a human judgement that no sync can reconstruct. Overwriting the file
// wholesale destroys them. Values are kept as raw lines rather than parsed and
// re-serialised, so a value this code does not understand survives byte for byte.
function splitNote(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(String(text || ''));
  if (!m) return { keys: [], blocks: {}, body: String(text || '') };

  const keys = [];
  const blocks = {};
  let current = null;
  for (const line of m[1].split('\n')) {
    // A top-level key: no leading whitespace, and not a list item.
    const key = /^([^\s#][^:]*):/.exec(line);
    if (key && !/^\s|^- /.test(line)) {
      current = key[1];
      if (!(current in blocks)) { keys.push(current); blocks[current] = []; }
      blocks[current].push(line);
    } else if (current) {
      blocks[current].push(line);
    }
  }
  return { keys, blocks, body: String(text).slice(m[0].length) };
}

// `order` is the whole contract for what this plugin writes: a property it
// produces that is NOT on the list is dropped, which is how the note is slimmed
// down to the properties actually wanted. That is deliberately different from
// `keep`, which carries raw blocks over from an existing note -- a hand-added
// property is not the plugin's to delete.
function frontmatter(obj, order, keep) {
  const lines = ['---'];
  const has = (k) => obj[k] !== undefined && obj[k] !== '' && obj[k] !== null;

  const written = new Set();
  const write = (k) => {
    if (written.has(k)) return;
    written.add(k);
    if (has(k)) {
      const v = obj[k];
      if (Array.isArray(v)) {
        if (!v.length) return;
        lines.push(`${k}:`);
        for (const entry of v) lines.push(`  - ${yamlScalar(entry)}`);
      } else {
        lines.push(`${k}: ${yamlScalar(v)}`);
      }
      return;
    }
    // Not produced this run. If the existing note had it, carry it over -- this
    // is what lets a hand-added property be POSITIONED by the order setting
    // rather than only appended.
    if (keep && keep.blocks[k]) lines.push(...keep.blocks[k]);
  };

  for (const k of order) write(k);

  // Anything else the existing note carried, verbatim, after the ordered part.
  if (keep) {
    for (const k of keep.keys) {
      if (k in obj) continue;
      write(k);
    }
  }

  lines.push('---');
  return lines.join('\n');
}

function yamlScalar(v) {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  if (s === '') return '""';
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s) || /: |\n|^\s|\s$/.test(s)) return JSON.stringify(s);
  return s;
}

// `mediaLinks` are embed strings the caller has already built from vault paths.
function renderPost(post, opts = {}) {
  const meta = post.meta || {};
  const author = authorOf(meta);
  const url = tweetUrl(meta);
  const text = expandUrls(meta.content, meta);

  const fm = {
    url: opts.urlAsLink && url ? `[Link](${url})` : url,
    // The link to the AUTHOR's profile note -- one property that both names the
    // author and gets you there. It is built from `author`, never from the
    // profile being synced: a quoted post on someone's timeline was written by
    // someone else, and handing it the synced profile's link credits the wrong
    // person. `x-profile`, which is the timeline it was FOUND on, stays separate
    // for exactly that reason.
    //
    // The target note may not exist -- an unresolved link to an unarchived
    // account is correct and still useful.
    'x-author': author.name
      ? (opts.authorAsLink !== false ? `[[@${author.name}]]` : `@${author.name}`)
      : '',
    'x-name': author.nick,
    'x-post-id': String(meta.tweet_id || meta.id || ''),
    published: isoDateTime(meta.date),
    likes: meta.favorite_count,
    reposts: meta.retweet_count,
    replies: meta.reply_count,
    lang: meta.lang,
    // Only set when the post was surfaced by SOMEONE ELSE -- a repost or a quote
    // on their timeline. On a post by the profile's own owner it would say the
    // author shared their own post, which is noise. That check is the whole
    // reason this property is legible: if it is there, someone passed it on.
    'shared-by': opts.sharedBy || '',
    'x-reply-to': meta.reply_id ? String(meta.reply_id) : '',
    'x-quotes': meta.quote_id ? String(meta.quote_id) : '',
    media: opts.mediaLinks && opts.mediaLinks.length ? opts.mediaLinks : '',
    'dl-ed': !!(opts.mediaLinks && opts.mediaLinks.length),
    tags: opts.tags || [],
  };

  const body = [];
  if (text) body.push(text);
  if (opts.embeds && opts.embeds.length) body.push(opts.embeds.join('\n'));
  if (meta.quote && meta.quote.content) {
    const q = authorOf(meta.quote);
    body.push(`**Quoting @${q.name}**\n${quoteBlock(expandUrls(meta.quote.content, meta.quote))}`);
  }
  if (url) body.push(`[View on X](${url})`);

  return `${frontmatter(fm, opts.order || DEFAULT_POST_ORDER, opts.keep)}\n\n${body.join('\n\n')}\n`;
}

function renderProfile(meta, opts = {}) {
  const a = meta.user || meta.author || {};
  const profileHref = a.name ? `https://x.com/${a.name}` : '';
  const fm = {
    // The hand-made notes write this as a markdown link rather than a bare URL.
    // It is a setting because it is a real choice, and because a sync overwrites
    // whichever form the note already had.
    url: opts.urlAsLink && profileHref ? `[Link](${profileHref})` : profileHref,
    // Embeds the caller has already built from vault paths, '' when the images
    // were not downloaded. They stay out of the body: these belong in
    // properties, which is where the hand-made notes put them.
    icon: opts.icon || '',
    banner: opts.banner || '',
    'x-author': a.name ? `@${a.name}` : '',
    'x-name': a.nick || '',
    'x-profile-id': String(a.id || ''),
    followers: a.followers_count,
    following: a.friends_count,
    posts: a.statuses_count,
    joined: isoDate(a.date),
    verified: a.verified,
    'x-synced': opts.syncedAt || '',
    count: opts.count || 0,
    tags: opts.tags || [],
  };
  // An existing body is kept as it is. A bio refresh is worth less than
  // whatever a human wrote under it, and these notes are rewritten every sync.
  if (typeof opts.body === 'string' && opts.body.trim()) {
    return `${frontmatter(fm, opts.order || DEFAULT_PROFILE_ORDER, opts.keep)}\n${opts.body.replace(/^\n+/, '\n')}`;
  }
  const body = [];
  if (a.description) body.push(a.description);
  if (a.location) body.push(`Location: ${a.location}`);
  return `${frontmatter(fm, opts.order || DEFAULT_PROFILE_ORDER, opts.keep)}\n\n${body.join('\n\n')}\n`;
}

// `x-author` and `x-name` are on BOTH note kinds deliberately: they are what
// ARCH After Clipping's otherArchKeys matches on to leave these notes alone.
// See CLAUDE.md -- renaming either one restarts the yt-dlp storm.
// x-name and x-profile are deliberately absent: x-author is now the link to the
// profile note, and the display name is one click away in it.
// `shared-by` is listed although it is usually absent: an empty value is skipped,
// so naming it costs nothing and positions it for the posts that do have one.
const DEFAULT_POST_ORDER = ['url', 'x-author', 'shared-by', 'published', 'media', 'tags'];
const DEFAULT_PROFILE_ORDER = ['url', 'icon', 'banner', 'x-author', 'x-name', 'followers', 'posts', 'joined', 'count', 'x-synced', 'tags'];

// The note name has to survive being a filename on three filesystems and stay
// recognisable in a list of 150 profiles' worth of posts.
function postNoteName(post, template) {
  const meta = post.meta || {};
  const author = authorOf(meta);
  const text = expandUrls(meta.content, meta).replace(/\s+/g, ' ');
  return sanitizeName(
    String(template || '{{author}} — {{date}} — {{excerpt}}')
      .replace(/\{\{author\}\}/g, author.name ? `@${author.name}` : 'unknown')
      .replace(/\{\{authorName\}\}/g, author.nick || '')
      .replace(/\{\{date\}\}/g, isoDate(meta.date))
      .replace(/\{\{id\}\}/g, String(meta.tweet_id || meta.id || ''))
      .replace(/\{\{excerpt\}\}/g, text.slice(0, 60).trim() || 'no text'),
    String(meta.tweet_id || 'post')
  );
}

module.exports = {
  renderPost, renderProfile, postNoteName, authorOf, tweetUrl, splitNote,
  isoDate, isoDateTime, frontmatter, DEFAULT_POST_ORDER, DEFAULT_PROFILE_ORDER,
};
