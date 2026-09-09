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

function frontmatter(obj, order) {
  const keys = [...order.filter((k) => obj[k] !== undefined && obj[k] !== '' && obj[k] !== null),
    ...Object.keys(obj).filter((k) => !order.includes(k) && obj[k] !== undefined && obj[k] !== '' && obj[k] !== null)];
  const lines = ['---'];
  for (const k of keys) {
    const v = obj[k];
    if (Array.isArray(v)) {
      if (!v.length) continue;
      lines.push(`${k}:`);
      for (const entry of v) lines.push(`  - ${yamlScalar(entry)}`);
    } else {
      lines.push(`${k}: ${yamlScalar(v)}`);
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
    url,
    'x-author': author.name ? `@${author.name}` : '',
    'x-author-name': author.nick,
    'x-post-id': String(meta.tweet_id || meta.id || ''),
    published: isoDateTime(meta.date),
    likes: meta.favorite_count,
    reposts: meta.retweet_count,
    replies: meta.reply_count,
    lang: meta.lang,
    'x-profile': opts.profileLink || '',
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

  return `${frontmatter(fm, opts.order || DEFAULT_POST_ORDER)}\n\n${body.join('\n\n')}\n`;
}

function renderProfile(meta, opts = {}) {
  const a = meta.user || meta.author || {};
  const fm = {
    url: a.name ? `https://x.com/${a.name}` : '',
    'x-author': a.name ? `@${a.name}` : '',
    'x-author-name': a.nick || '',
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
  const body = [];
  if (a.description) body.push(a.description);
  if (a.location) body.push(`Location: ${a.location}`);
  return `${frontmatter(fm, opts.order || DEFAULT_PROFILE_ORDER)}\n\n${body.join('\n\n')}\n`;
}

const DEFAULT_POST_ORDER = ['dl-ed', 'url', 'x-author', 'x-author-name', 'x-post-id', 'published', 'x-profile', 'media', 'likes', 'reposts', 'replies', 'tags'];
const DEFAULT_PROFILE_ORDER = ['url', 'x-author', 'x-author-name', 'followers', 'posts', 'joined', 'count', 'x-synced', 'tags'];

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
  renderPost, renderProfile, postNoteName, authorOf, tweetUrl,
  isoDate, isoDateTime, frontmatter, DEFAULT_POST_ORDER, DEFAULT_PROFILE_ORDER,
};
