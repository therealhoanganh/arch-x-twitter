'use strict';

const { Plugin, PluginSettingTab, Setting, Notice, Modal, TFile, TFolder, normalizePath, requestUrl } = require('obsidian');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const DEFAULT_SETTINGS = {
  // --- what to archive ---
  // Each entry: { handle, timeline, note, tags, enabled }
  profiles: [],
  timeline: 'posts',        // posts | replies | media | likes
  retweets: false,
  replies: false,
  quoted: true,
  textTweets: true,
  videos: true,
  maxPerProfile: 200,       // gallery-dl --range 1-N; 0 means everything
  sleepRequest: 1.5,        // seconds between requests; X rate-limits hard

  // --- where notes land ---
  // Both use the same five-mode vocabulary as the other ARCH plugins. The
  // anchor differs: a profile note is placed relative to the archive root, a
  // post note relative to its own profile note.
  archiveRoot: 'Twitter',
  profileLocationMode: 'specified', // vault | root | subfolder | specified | perProfile
  profileSubfolder: 'Profiles',
  profileFolder: 'Twitter/Profiles',
  postLocationMode: 'specified',    // vault | same | subfolder | specified | perProfile
  postSubfolder: 'Posts',
  postFolder: 'Twitter/Posts',
  postNoteNameTemplate: '{{author}} — {{date}} — {{excerpt}}',
  urlAsLink: true,
  authorAsLink: true,
  tags: ['x-twitter-post'],
  profileTags: ['x-twitter-profile'],
  postNoteOrder: 'url, x-author, shared-by, published, media, tags',
  // A profile note exists to be linked to, not to report statistics: follower
  // and post counts are noise next to the hand-assigned t-rank that actually
  // decides what matters. t-rank is listed although this plugin never produces
  // it -- naming it here is what positions it when the existing note carries it.
  //
  // x-author is deliberately absent: on a profile note it restates the title.
  // That leaves x-name as the ONLY marker keeping ARCH After Clipping off these
  // notes -- see the coupling section in CLAUDE.md before removing it too.
  profileNoteOrder: 'url, icon, banner, t-rank, x-name, tags',

  // --- profile picture and header ---
  // The defaults reproduce the layout the hand-made notes already use:
  // Twitter/Profiles/Images, named "@handle Icon.webp" / "@handle Banner.webp".
  downloadProfileImages: true,
  profileImageLocationMode: 'subfolder', // vault | same | subfolder | specified | perProfile
  profileImageSubfolder: 'Images',
  profileImageFolder: 'Twitter/Profiles/Images',
  profileImageFormat: 'webp',            // webp | keep
  iconNameTemplate: '{{author}} Icon',
  bannerNameTemplate: '{{author}} Banner',
  refreshProfileImages: false,

  // --- media ---
  downloadMedia: true,
  mediaLocationMode: 'subfolder', // vault | same | subfolder | specified
  mediaSubfolder: 'Materials',
  mediaFolder: 'X/Media',

  // --- external tool ---
  galleryDlPath: 'gallery-dl',
  cookiesFromBrowser: '',
  cookiesFile: '',
  useDownloadArchive: true,
  extraArgs: '',

  setupDone: false,
};

class ArchXArchivePlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.procs = new Set();
    this.queue = Promise.resolve();

    this.addCommand({ id: 'sync-all-profiles', name: 'Sync all profiles', callback: () => this.enqueue(() => this.syncAll()) });
    this.addCommand({ id: 'archive-url', name: 'Archive an X post or profile by URL…', callback: () => this.promptForUrl() });
    this.addCommand({ id: 'setup', name: 'Set up gallery-dl', callback: () => this.setup() });

    this.addSettingTab(new ArchXSettingTab(this.app, this));

    if (!this.settings.setupDone) {
      // First run only. Detection is a handful of `--version` calls, so it is
      // cheap, but it is not something to repeat on every load.
      this.app.workspace.onLayoutReady(() => {
        this.settings.setupDone = true;
        this.saveSettings().then(() => this.setup());
      });
    }
    this.log('loaded', this.manifest.version);
  }

  onunload() {
    for (const p of this.procs) { try { p.kill(); } catch (_) { /* already gone */ } }
  }

  lib() {
    if (this._lib) return this._lib;
    if (typeof ARCH_LIB !== 'undefined') { this._lib = ARCH_LIB; return this._lib; }
    const dir = path.join(this.vaultRoot(), this.app.vault.configDir, 'plugins', this.manifest.id, 'lib');
    this._lib = require(path.join(dir, 'index.js'));
    return this._lib;
  }

  vaultRoot() { return this.app.vault.adapter.getBasePath(); }
  pluginDir() { return path.join(this.vaultRoot(), this.app.vault.configDir, 'plugins', this.manifest.id); }
  binDir() { return path.join(this.pluginDir(), 'bin'); }
  log(...a) { console.log('[arch-x]', ...a); }

  enqueue(task) {
    this.queue = this.queue.then(task, task).catch((e) => {
      console.error('[arch-x]', e);
      new Notice(`Sync failed: ${e.message}`, 10000);
    });
    return this.queue;
  }

  /* ---------------- running gallery-dl ---------------- */

  buildEnv() {
    const env = Object.assign({}, process.env);
    if (process.platform !== 'win32') {
      const extras = [
        path.join(this.binDir(), 'venv', 'bin'),
        '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
        path.join(os.homedir(), '.local', 'bin'),
      ];
      env.PATH = [...extras, env.PATH || ''].filter(Boolean).join(path.delimiter);
    }
    return env;
  }

  run(command, args, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const child = execFile(command, args, {
        env: this.buildEnv(),
        encoding: 'utf8',
        maxBuffer: 1024 * 1024 * 256, // a 3000-post timeline of JSON
        timeout: timeoutMs || 0,
        windowsHide: true,
      }, (err, stdout, stderr) => {
        if (err && err.code === 'ENOENT') return reject(err);
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout || '', stderr: stderr || '' });
      });
      this.procs.add(child);
      child.on('close', () => this.procs.delete(child));
    });
  }

  async runGalleryDl(target, opts, timeoutMs) {
    const args = this.lib().buildArgs(target, {
      cookiesFromBrowser: this.settings.cookiesFromBrowser,
      cookiesFile: this.settings.cookiesFile,
      retweets: this.settings.retweets,
      replies: this.settings.replies,
      quoted: this.settings.quoted,
      textTweets: this.settings.textTweets,
      videos: this.settings.videos,
      sleepRequest: this.settings.sleepRequest,
      extraArgs: this.settings.extraArgs,
      ...opts,
    });
    this.log('gallery-dl', args.join(' '));
    const r = await this.run(this.settings.galleryDlPath || 'gallery-dl', args, timeoutMs);
    this.log('exit', r.code, 'stdout', r.stdout.length, 'bytes');
    if (r.stderr.trim()) this.log('stderr', r.stderr.trim().split('\n').slice(-5).join('\n'));
    return r;
  }

  /* ---------------- detection and setup ---------------- */

  exeName(base) { return process.platform === 'win32' ? `${base}.exe` : base; }

  candidatePaths(base) {
    const name = this.exeName(base);
    const list = [
      path.join(this.binDir(), 'venv', process.platform === 'win32' ? 'Scripts' : 'bin', name),
      path.join(this.binDir(), name),
    ];
    if (process.platform === 'win32') {
      list.push(
        path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', name),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Scripts', name),
        name
      );
    } else {
      list.push(
        `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`,
        path.join(os.homedir(), '.local', 'bin', name),
        name
      );
    }
    return list.filter(Boolean);
  }

  async resolveAbsolutePath(name) {
    if (path.isAbsolute(name)) return name;
    try {
      const r = await this.run(process.platform === 'win32' ? 'where' : 'which', [name], 8000);
      if (r.code === 0) {
        const first = r.stdout.split('\n').map((x) => x.trim()).filter(Boolean)[0];
        if (first && path.isAbsolute(first)) return first;
      }
    } catch (_) { /* fall through */ }
    return name;
  }

  async findBinary(base, versionArgs = ['--version']) {
    for (const candidate of this.candidatePaths(base)) {
      try {
        const r = await this.run(candidate, versionArgs, 15000);
        if (r.code === 0) {
          return { found: true, path: await this.resolveAbsolutePath(candidate), version: (r.stdout || r.stderr).trim().split('\n')[0] };
        }
      } catch (_) { /* next candidate */ }
    }
    return { found: false, path: null, version: null };
  }

  browserProfiles() {
    const home = os.homedir();
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    if (process.platform === 'darwin') {
      const sup = path.join(home, 'Library', 'Application Support');
      return [
        { name: 'chrome', dir: path.join(sup, 'Google', 'Chrome') },
        { name: 'brave', dir: path.join(sup, 'BraveSoftware', 'Brave-Browser') },
        { name: 'edge', dir: path.join(sup, 'Microsoft Edge') },
        { name: 'firefox', dir: path.join(sup, 'Firefox') },
        { name: 'safari', dir: path.join(home, 'Library', 'Safari') },
      ];
    }
    if (process.platform === 'win32') {
      return [
        { name: 'chrome', dir: path.join(local, 'Google', 'Chrome', 'User Data') },
        { name: 'edge', dir: path.join(local, 'Microsoft', 'Edge', 'User Data') },
        { name: 'brave', dir: path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data') },
        { name: 'firefox', dir: path.join(roaming, 'Mozilla', 'Firefox') },
      ];
    }
    return [
      { name: 'chrome', dir: path.join(home, '.config', 'google-chrome') },
      { name: 'chromium', dir: path.join(home, '.config', 'chromium') },
      { name: 'firefox', dir: path.join(home, '.mozilla', 'firefox') },
    ];
  }

  detectBrowsers() {
    const out = [];
    for (const b of this.browserProfiles()) {
      try {
        const st = fs.statSync(b.dir);
        if (st.isDirectory()) out.push({ ...b, mtime: st.mtimeMs });
      } catch (_) { /* not installed */ }
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  async detectTools() {
    const r = {};
    r.gallerydl = await this.findBinary('gallery-dl');
    r.python = await this.findBinary('python3', ['--version']);
    r.ffmpeg = await this.findBinary('ffmpeg', ['-version']);
    r.browsers = this.detectBrowsers();
    return r;
  }

  async autoConfigure(report) {
    const filled = [];
    if (report.gallerydl.found && path.isAbsolute(report.gallerydl.path) && report.gallerydl.path !== this.settings.galleryDlPath) {
      this.settings.galleryDlPath = report.gallerydl.path;
      filled.push(`gallery-dl path → ${report.gallerydl.path}`);
    }
    if (!this.settings.cookiesFile && !this.settings.cookiesFromBrowser && report.browsers.length) {
      const usable = report.browsers.find((b) => b.name !== 'safari') || report.browsers[0];
      this.settings.cookiesFromBrowser = usable.name;
      filled.push(`Cookies from browser → ${usable.name}`);
    }
    if (filled.length) await this.saveSettings();
    return filled;
  }

  // gallery-dl publishes NO prebuilt binaries -- checked against the last eight
  // releases, every one of which has zero release assets. The yt-dlp trick of
  // downloading a standalone executable does not transfer. A private venv is the
  // closest equivalent: self-contained, removable with the plugin folder, and it
  // does not touch the user's system Python.
  async installGalleryDl() {
    const python = (await this.findBinary('python3', ['--version'])).path || 'python3';
    const venv = path.join(this.binDir(), 'venv');
    const pip = path.join(venv, process.platform === 'win32' ? 'Scripts' : 'bin', this.exeName('pip'));
    const bin = path.join(venv, process.platform === 'win32' ? 'Scripts' : 'bin', this.exeName('gallery-dl'));

    const notice = new Notice('Creating a private Python environment…', 0);
    try {
      fs.mkdirSync(this.binDir(), { recursive: true });
      let r = await this.run(python, ['-m', 'venv', venv], 180000);
      if (r.code !== 0) throw new Error(`venv failed: ${r.stderr.trim().split('\n').slice(-2).join(' ')}`);

      notice.setMessage('Installing gallery-dl…');
      r = await this.run(pip, ['install', '--upgrade', 'gallery-dl'], 300000);
      if (r.code !== 0) throw new Error(`pip failed: ${r.stderr.trim().split('\n').slice(-2).join(' ')}`);

      const check = await this.run(bin, ['--version'], 20000);
      notice.hide();
      if (check.code !== 0) { new Notice('gallery-dl installed but would not run.', 10000); return false; }

      this.settings.galleryDlPath = bin;
      await this.saveSettings();
      new Notice(`gallery-dl ${check.stdout.trim()} installed.`, 8000);
      return true;
    } catch (e) {
      notice.hide();
      new Notice(`Could not install gallery-dl: ${e.message}\nTry: brew install gallery-dl`, 15000);
      return false;
    }
  }

  async updateGalleryDl() {
    const bin = this.settings.galleryDlPath || 'gallery-dl';
    const venvPip = bin.includes(path.join('bin', 'venv')) || bin.includes(`${path.sep}venv${path.sep}`)
      ? path.join(path.dirname(bin), this.exeName('pip'))
      : null;
    const notice = new Notice('Updating gallery-dl…', 0);
    const r = venvPip
      ? await this.run(venvPip, ['install', '--upgrade', 'gallery-dl'], 300000)
      : { code: 1, stderr: 'not a managed install' };
    notice.hide();
    if (r.code === 0) new Notice('gallery-dl is up to date.', 6000);
    else new Notice('Update it the way you installed it (brew upgrade gallery-dl, or pip install -U gallery-dl).', 12000);
  }

  async setup() {
    const notice = new Notice('Looking for gallery-dl, Python, browsers…', 0);
    const report = await this.detectTools();
    const filled = await this.autoConfigure(report);
    notice.hide();
    this.log('tool report', report, 'filled', filled);
    new SetupModal(this.app, this, report, filled).open();
  }

  /* ---------------- syncing ---------------- */

  async syncAll() {
    const active = (this.settings.profiles || []).filter((p) => p.enabled !== false && p.handle);
    if (!active.length) return new Notice('No profiles configured yet. Add some in settings.', 8000);
    this.buildPostIndex();
    const notice = new Notice(`Syncing 0/${active.length} profiles…`, 0);
    let written = 0, failed = 0;
    for (let i = 0; i < active.length; i++) {
      notice.setMessage(`Syncing ${i + 1}/${active.length}\n@${active[i].handle}`);
      try {
        written += await this.syncProfile(active[i]);
      } catch (e) {
        failed++;
        console.error('[arch-x]', active[i].handle, e);
      }
    }
    notice.hide();
    new Notice(`Done. ${written} new notes from ${active.length} profiles.` + (failed ? ` ${failed} failed.` : ''), 12000);
  }

  async syncProfile(profile) {
    const { profileUrl, parseDumpJson, groupByTweet } = this.lib();
    const target = profileUrl(profile.handle, profile.timeline || this.settings.timeline);
    if (!target) throw new Error(`"${profile.handle}" is not a usable handle`);

    if (!this.postIndex) this.buildPostIndex();
    const max = Number(profile.maxPerProfile ?? this.settings.maxPerProfile) || 0;
    const r = await this.runGalleryDl(target, {
      dumpJson: true,
      postRange: max ? `1-${max}` : '',
      archiveFile: this.settings.useDownloadArchive ? this.archivePath() : '',
    }, 0);

    const parsed = parseDumpJson(r.stdout);

    // gallery-dl reports a refused timeline IN-BAND: exit 0, empty stderr, and a
    // [-1, {error, message}] row on stdout. Checking the exit code alone reports
    // "0 posts, fine" for a profile that actually said no.
    if (parsed.errors.length) {
      throw new Error(this.explain(parsed.errors.map((e) => `${e.error || ''} ${e.message || ''}`).join('; ')));
    }
    if (r.code !== 0 && !parsed.items.length) {
      throw new Error(this.explain(r.stderr) || `gallery-dl exited ${r.code}`);
    }
    // A Queue row and nothing else means the URL was handed to another extractor
    // rather than enumerated -- which is what a bare x.com/<name> does.
    if (!parsed.items.length && parsed.queued.length) {
      throw new Error(`gallery-dl passed ${target} on to another extractor instead of listing posts. Use an explicit timeline URL.`);
    }
    const posts = groupByTweet(parsed.items);
    this.log(`@${profile.handle}: ${posts.length} posts`);
    if (!posts.length) return 0;

    const profileFolder = await this.folderFor(profile);
    await this.writeProfileNote(profile, posts, profileFolder);

    const postFolder = this.postFolderFor(profile, profileFolder);
    if (postFolder !== profileFolder) await this.ensureFolder(postFolder);

    let written = 0;
    for (const post of posts) {
      if (await this.writePostNote(post, profile, postFolder)) written++;
    }
    return written;
  }

  // Each of these has a different fix, and gallery-dl's own wording says none of
  // them. AuthRequired in particular is what /media and /with_replies return for
  // a logged-out client, and it reads like a bug rather than a missing setting.
  explain(raw) {
    const s = String(raw || '');
    if (/AuthRequired|authenticated cookies/i.test(s)) return 'That timeline needs a logged-in session. Pick a browser under "Cookies from browser" in settings — Posts works without one, but replies, media and likes do not.';
    if (/401|Unauthorized|login|authorization/i.test(s)) return 'X refused the request — cookies are missing or stale. Log in to X in your browser, then sync again.';
    if (/429|rate.?limit/i.test(s)) return 'Rate-limited by X. Raise "Seconds between requests" and try a smaller batch.';
    if (/404|Not Found|suspended/i.test(s)) return 'Profile not found, suspended, or protected.';
    return s.trim().split('\n').filter(Boolean).slice(-1)[0] || 'gallery-dl returned nothing usable.';
  }

  archivePath() { return path.join(this.pluginDir(), 'seen.sqlite3'); }


  /* ---------------- profile picture and header ---------------- */

  // Returns { icon, banner } as embed strings ready for frontmatter, '' for
  // anything not downloaded. A failure here never fails the sync: a missing
  // avatar is not a reason to lose a profile's posts.
  async fetchProfileImages(profile, meta, profileFolder) {
    if (!this.settings.downloadProfileImages) return { icon: '', banner: '' };
    const { profileImageUrls } = this.lib();
    const urls = profileImageUrls(meta);
    if (!urls.icon && !urls.banner) {
      this.log('no profile image urls in metadata for', profile.handle);
      return { icon: '', banner: '' };
    }

    const folder = this.imageFolderFor(profile, profileFolder);
    if (folder) await this.ensureFolder(folder);

    const out = {};
    for (const [key, url, template] of [
      ['icon', urls.icon, this.settings.iconNameTemplate],
      ['banner', urls.banner, this.settings.bannerNameTemplate],
    ]) {
      out[key] = '';
      if (!url) continue;
      try {
        const file = await this.saveProfileImage(url, folder, this.imageStem(template, profile));
        if (file) out[key] = this.embedFor(file, profileFolder, key === 'icon' ? 'Icon' : 'Banner');
      } catch (e) {
        this.log(`${key} failed for @${profile.handle}:`, e.message);
      }
    }
    return out;
  }

  imageStem(template, profile) {
    const { sanitizeName } = this.lib();
    return sanitizeName(
      String(template || '{{author}}')
        .replace(/\{\{author\}\}/gi, `@${profile.handle}`)
        .replace(/\{\{handle\}\}/gi, profile.handle),
      `@${profile.handle}`
    );
  }

  // Whether an image is already here is decided by LOOKING FOR THE FILE, under
  // any extension it might have been saved with -- never by a property. Same
  // discipline as ARCH YT Playlists' download check, and the reason a re-sync of
  // 150 profiles does not re-fetch 300 images.
  existingImage(folder, stem) {
    for (const ext of ['.webp', '.jpg', '.jpeg', '.png', '.gif']) {
      const hit = this.app.vault.getAbstractFileByPath(normalizePath(folder ? `${folder}/${stem}${ext}` : `${stem}${ext}`));
      if (hit instanceof TFile) return hit;
    }
    return null;
  }

  async saveProfileImage(url, folder, stem) {
    const existing = this.existingImage(folder, stem);
    if (existing && !this.settings.refreshProfileImages) return existing;

    // requestUrl rather than fetch: it is Obsidian's own client, so it is not
    // subject to the renderer's CORS rules and follows redirects.
    const res = await requestUrl({ url, throw: false });
    if (res.status !== 200 || !res.arrayBuffer || !res.arrayBuffer.byteLength) {
      throw new Error(`HTTP ${res.status}`);
    }
    const type = (res.headers && (res.headers['content-type'] || res.headers['Content-Type'])) || 'image/jpeg';
    let bytes = new Uint8Array(res.arrayBuffer);
    let ext = extFromType(type, url);

    if (this.settings.profileImageFormat === 'webp' && ext !== '.webp') {
      try {
        const { encodeWebp } = this.lib();
        const encoded = await encodeWebp(new Blob([res.arrayBuffer], { type }), 0.85);
        if (encoded.data) { bytes = encoded.data; ext = '.webp'; }
      } catch (e) {
        // A profile picture in a format Chromium will not decode is not worth
        // failing over; the original is perfectly usable.
        this.log('webp encode failed, keeping the original:', e.message);
      }
    }

    const target = normalizePath(folder ? `${folder}/${stem}${ext}` : `${stem}${ext}`);
    const already = this.app.vault.getAbstractFileByPath(target);
    if (already instanceof TFile) {
      await this.app.vault.modifyBinary(already, bytes);
      return already;
    }
    await this.app.vault.createBinary(target, bytes);
    const created = this.app.vault.getAbstractFileByPath(target);
    return created instanceof TFile ? created : null;
  }

  // Matches what the hand-made notes carry: an aliased wikilink, so the property
  // renders as an image and reads as a word.
  embedFor(file, fromFolder, alias) {
    let link = file.path;
    try {
      link = this.app.metadataCache.fileToLinktext(file, fromFolder ? `${fromFolder}/x.md` : 'x.md', true);
    } catch (_) { /* fall back to the full path */ }
    return `[[${link}|${alias}]]`;
  }

  /* ---------------- note writing ---------------- */

  // Tokens usable in either folder setting. `{{handle}}` is the one that matters;
  // the rest are there because a date-partitioned archive is the obvious next
  // thing someone wants and adding them later would be a settings migration.
  expandFolderTokens(raw, profile) {
    const { sanitizeName } = this.lib();
    const now = new Date();
    return String(raw || '')
      .replace(/\\/g, '/')
      .replace(/\{\{handle\}\}/gi, profile ? profile.handle : '')
      .replace(/\{\{author\}\}/gi, profile ? `@${profile.handle}` : '')
      .replace(/\{\{date\}\}/gi, now.toISOString().slice(0, 10))
      .replace(/\{\{year\}\}/gi, String(now.getFullYear()))
      .replace(/\{\{month\}\}/gi, String(now.getMonth() + 1).padStart(2, '0'))
      .split('/')
      .map((seg) => (seg === '.' || seg === '' ? '' : sanitizeName(seg, '')))
      .filter(Boolean)
      .join('/');
  }

  // A profile note is placed relative to the archive root.
  profileFolderFor(profile) {
    const { sanitizeName } = this.lib();
    const s = this.settings;
    const root = this.expandFolderTokens(s.archiveRoot, profile);
    const handle = sanitizeName('@' + profile.handle);
    switch (s.profileLocationMode) {
      case 'vault': return '';
      case 'root': return root;
      case 'subfolder': {
        const sub = this.expandFolderTokens(s.profileSubfolder, profile);
        return [root, sub].filter(Boolean).join('/');
      }
      case 'perProfile': {
        const base = this.expandFolderTokens(s.profileFolder, profile) || root;
        return [base, handle].filter(Boolean).join('/');
      }
      default: return this.expandFolderTokens(s.profileFolder, profile) || root;
    }
  }

  // A post note is placed relative to its own profile note, which is why
  // `same` and `subfolder` mean something here and `root` does not.
  postFolderFor(profile, profileFolder) {
    const { sanitizeName } = this.lib();
    const s = this.settings;
    const handle = sanitizeName('@' + profile.handle);
    switch (s.postLocationMode) {
      case 'vault': return '';
      case 'same': return profileFolder;
      case 'subfolder': {
        const sub = this.expandFolderTokens(s.postSubfolder, profile);
        return [profileFolder, sub].filter(Boolean).join('/');
      }
      case 'perProfile': {
        const base = this.expandFolderTokens(s.postFolder, profile);
        return [base, handle].filter(Boolean).join('/');
      }
      default: return this.expandFolderTokens(s.postFolder, profile) || profileFolder;
    }
  }

  // Anchored on the profile note, like post notes are. The default -- subfolder
  // "Images" beside the profile note -- resolves to Twitter/Profiles/Images.
  imageFolderFor(profile, profileFolder) {
    const { sanitizeName } = this.lib();
    const s = this.settings;
    const handle = sanitizeName('@' + profile.handle);
    switch (s.profileImageLocationMode) {
      case 'vault': return '';
      case 'same': return profileFolder;
      case 'specified': return this.expandFolderTokens(s.profileImageFolder, profile);
      case 'perProfile': {
        const base = this.expandFolderTokens(s.profileImageFolder, profile);
        return [base, handle].filter(Boolean).join('/');
      }
      default: {
        const sub = this.expandFolderTokens(s.profileImageSubfolder, profile);
        return [profileFolder, sub].filter(Boolean).join('/');
      }
    }
  }

  async folderFor(profile) {
    const folder = this.profileFolderFor(profile);
    await this.ensureFolder(folder);
    return folder;
  }

  async writeProfileNote(profile, posts, folder) {
    const { renderProfile, sanitizeName, splitNote } = this.lib();
    const first = posts.find((p) => p.meta && (p.meta.user || p.meta.author));
    const meta = first ? first.meta : { user: { name: profile.handle } };
    const name = sanitizeName(profile.note || `@${profile.handle}`);
    const notePath = normalizePath(`${folder}/${name}.md`);
    const images = await this.fetchProfileImages(profile, meta, folder);

    // A profile note is rewritten on every sync, and these notes carry hand-added
    // properties -- t-rank is a human judgement no sync can reconstruct -- and
    // hand-written bodies. Read the existing note and carry both across.
    const existing = this.app.vault.getAbstractFileByPath(notePath);
    let keep = null;
    let existingBody = '';
    if (existing instanceof TFile) {
      const raw = await this.app.vault.read(existing);
      const split = splitNote(raw);
      keep = split;
      existingBody = split.body;
    }

    const body = renderProfile(meta, {
      keep,
      body: existingBody,
      urlAsLink: this.settings.urlAsLink,
      icon: images.icon,
      banner: images.banner,
      tags: splitList(profile.tags || this.settings.profileTags.join(', ')),
      count: posts.length,
      syncedAt: new Date().toISOString().slice(0, 19) + 'Z',
      order: splitList(this.settings.profileNoteOrder),
    });
    if (existing instanceof TFile) await this.app.vault.modify(existing, body);
    else await this.app.vault.create(notePath, body);
    return notePath;
  }

  // Returns true when a note was created. An existing post is left completely
  // alone: X counts change constantly, and rewriting 150 profiles' worth of
  // notes on every sync to update a like count would churn the whole vault.
  async writePostNote(post, profile, folder) {
    const { renderPost, postNoteName, canonicalId } = this.lib();
    const name = postNoteName(post, this.settings.postNoteNameTemplate);
    const notePath = normalizePath(`${folder}/${name}.md`);
    // canonicalId, not post.id: on a repost those differ, and de-duplicating on
    // the repost's own id would file the same original once per reposter.
    const identity = canonicalId(post.meta);
    if (this.app.vault.getAbstractFileByPath(notePath)) return false;
    if (this.findByPostId(identity)) return false;

    // `shared-by` only when this post is not the profile owner's own: the author
    // wrote it, this profile passed it on. Comparing handles case-insensitively
    // because X is inconsistent about capitalisation between the two fields.
    const { authorOf } = this.lib();
    const wroteIt = String(authorOf(post.meta).name || '').toLowerCase();
    const owner = String(profile.handle || '').toLowerCase();
    const sharedBy = wroteIt && owner && wroteIt !== owner
      ? `[[${profile.note || '@' + profile.handle}]]`
      : '';

    const body = renderPost(post, {
      urlAsLink: this.settings.urlAsLink,
      authorAsLink: this.settings.authorAsLink,
      sharedBy,
      tags: splitList(profile.tags || this.settings.tags.join(', ')),
      order: splitList(this.settings.postNoteOrder),
      mediaLinks: [],
      embeds: [],
    });
    const created = await this.app.vault.create(notePath, body);
    // metadataCache has not seen the new note yet, so the index has to be told.
    if (this.postIndex) this.postIndex.set(identity, created);
    return true;
  }

  // A post found on two timelines -- a reply archived from both people -- would
  // otherwise be written twice under two names. The id is the identity, not the
  // filename, because the name template can change.
  //
  // The index is built ONCE per sync run and updated as notes are written.
  // Scanning every markdown file per post is what the obvious version does, and
  // at 150 profiles x 200 posts that is 30,000 full-vault scans.
  // Indexed by BOTH x-post-id and the post URL. The URL already contains the id,
  // so dedup keeps working when x-post-id is eventually dropped from the
  // template -- which is the plan. Do not reduce this to one key without
  // checking which one the notes on disk still carry.
  buildPostIndex() {
    const index = new Map();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (!fm) continue;
      if (fm['x-post-id']) index.set(String(fm['x-post-id']), file);
      const fromUrl = String(fm.url || '').match(/\/status\/(\d+)/);
      if (fromUrl) index.set(fromUrl[1], file);
    }
    this.postIndex = index;
    return index;
  }

  findByPostId(id) {
    if (!this.postIndex) this.buildPostIndex();
    return this.postIndex.get(String(id)) || null;
  }

  async ensureFolder(folderPath) {
    const parts = String(folderPath || '').split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFolder) continue;
      if (existing) throw new Error(`"${current}" exists but is a file, not a folder.`);
      try { await this.app.vault.createFolder(current); }
      catch (e) { if (!/exists/i.test(String(e && e.message))) throw e; }
    }
  }

  /* ---------------- single URL ---------------- */

  promptForUrl() {
    new UrlModal(this.app, async (url) => {
      if (!url) return;
      const { handleFromUrl } = this.lib();
      const handle = handleFromUrl(url);
      if (!handle) return new Notice('That does not look like an x.com URL.', 6000);
      this.enqueue(async () => {
        const profile = { handle, timeline: 'posts', note: `@${handle}`, tags: '' };
        const n = await this.syncProfile(profile);
        new Notice(`${n} new notes from @${handle}.`, 8000);
      });
    }).open();
  }

  /* ---------------- settings ---------------- */

  async loadSettings() {
    const saved = (await this.loadData()) || {};
    const before = JSON.stringify(saved);
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    if (!Array.isArray(this.settings.profiles)) this.settings.profiles = [];
    // 0.1.0 had a single archiveRoot plus a per-profile-folder toggle. Only
    // migrate when there is a saved config predating the modes: on a fresh
    // install `saved` is empty and running this would stomp the defaults.
    if (Object.keys(saved).length && saved.profileLocationMode === undefined) {
      const root = saved.archiveRoot || 'X/Profiles';
      this.settings.profileLocationMode = saved.profileNoteInOwnFolder ? 'perProfile' : 'specified';
      this.settings.profileFolder = root;
      this.settings.postLocationMode = 'same';
    }
    delete this.settings.profileNoteInOwnFolder;
    // x-author-name became x-name. A saved order string still naming the old key
    // would silently drop the property to the bottom of the frontmatter.
    for (const key of ['postNoteOrder', 'profileNoteOrder']) {
      if (typeof this.settings[key] === 'string' && this.settings[key].includes('x-author-name')) {
        this.settings[key] = this.settings[key].replace(/x-author-name/g, 'x-name');
      }
    }
    // A saved order string predates any property added since it was saved, and
    // the order list is now what decides whether a property is written at all --
    // so a new one has to be inserted, not left to be appended or dropped.
    // Inserted after `url`, which every order string starts with.
    for (const [key, added] of [['profileNoteOrder', ['icon', 'banner']], ['postNoteOrder', []]]) {
      const list = splitList(this.settings[key]);
      const missing = added.filter((k) => !list.includes(k));
      if (!missing.length) continue;
      const at = list.indexOf('url');
      list.splice(at >= 0 ? at + 1 : 0, 0, ...missing);
      this.settings[key] = list.join(', ');
    }

    // Migrations run in memory. Without this they re-run on every load and, worse,
    // never reach data.json -- so the settings tab shows one thing and the file
    // says another until something unrelated triggers a save.
    if (JSON.stringify(this.settings) !== before) await this.saveData(this.settings);
    if (!Array.isArray(this.settings.tags)) this.settings.tags = [];
    if (!Array.isArray(this.settings.profileTags)) this.settings.profileTags = [];
  }

  async saveSettings() { await this.saveData(this.settings); }
}

/* ---------------- helpers ---------------- */

function extFromType(type, url) {
  const t = String(type || '').toLowerCase();
  if (t.includes('webp')) return '.webp';
  if (t.includes('png')) return '.png';
  if (t.includes('gif')) return '.gif';
  if (t.includes('jpeg') || t.includes('jpg')) return '.jpg';
  const fromUrl = String(url || '').match(/\.(webp|png|gif|jpe?g)(?:[?#]|$)/i);
  return fromUrl ? `.${fromUrl[1].toLowerCase().replace('jpeg', 'jpg')}` : '.jpg';
}

function splitList(raw) {
  if (Array.isArray(raw)) return raw;
  return String(raw || '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}

/* ---------------- modals ---------------- */

class UrlModal extends Modal {
  constructor(app, onSubmit) { super(app); this.onSubmit = onSubmit; }
  onOpen() {
    this.titleEl.setText('Archive from X');
    const input = this.contentEl.createEl('input', { type: 'text', placeholder: 'https://x.com/someone or a post URL' });
    input.style.width = '100%';
    input.focus();
    const go = () => { this.close(); this.onSubmit(input.value.trim()); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    const row = this.contentEl.createDiv({ cls: 'modal-button-container' });
    row.createEl('button', { text: 'Archive', cls: 'mod-cta' }).onclick = go;
  }
}

class SetupModal extends Modal {
  constructor(app, plugin, report, filled) { super(app); this.plugin = plugin; this.report = report; this.filled = filled; }
  onOpen() {
    const { contentEl } = this;
    this.titleEl.setText('ARCH X Archive — setup');
    const r = this.report;

    const row = (label, ok, detail) => {
      const p = contentEl.createEl('p');
      p.createSpan({ text: ok ? '✓ ' : '✗ ' });
      p.createSpan({ text: label + ' ' });
      p.createEl('code', { text: detail || (ok ? 'found' : 'not found') });
    };

    row('gallery-dl', r.gallerydl.found, r.gallerydl.found ? `${r.gallerydl.version} — ${r.gallerydl.path}` : 'not found');
    row('Python 3', r.python.found, r.python.found ? r.python.version : 'not found');
    row('ffmpeg', r.ffmpeg.found, r.ffmpeg.found ? 'found (needed for video)' : 'not found — video will not merge');
    row('Browser cookies', r.browsers.length > 0, r.browsers.map((b) => b.name).join(', ') || 'none detected');

    if (this.filled.length) {
      contentEl.createEl('p', { text: 'Filled in for you:' });
      const ul = contentEl.createEl('ul');
      for (const f of this.filled) ul.createEl('li', { text: f });
    }

    if (!r.gallerydl.found) {
      contentEl.createEl('p', {
        text: 'gallery-dl publishes no prebuilt binary, so it is installed into a private Python environment inside this plugin\'s folder. Nothing outside the plugin is touched, and removing the plugin removes it.',
      });
      const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
      buttons.createEl('button', { text: 'Install gallery-dl', cls: 'mod-cta' }).onclick = async () => {
        this.close();
        if (await this.plugin.installGalleryDl()) this.plugin.setup();
      };
      buttons.createEl('button', { text: 'I will install it myself' }).onclick = () => this.close();
    } else {
      contentEl.createEl('p', {
        text: 'X requires a logged-in session for almost everything. Cookies are read from the browser named above at the moment of each run — nothing is stored by this plugin.',
      });
      const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
      buttons.createEl('button', { text: 'Update gallery-dl' }).onclick = () => { this.close(); this.plugin.updateGalleryDl(); };
      buttons.createEl('button', { text: 'Done', cls: 'mod-cta' }).onclick = () => this.close();
    }
  }
}

class BulkAddModal extends Modal {
  constructor(app, plugin, onDone) { super(app); this.plugin = plugin; this.onDone = onDone; }
  onOpen() {
    this.titleEl.setText('Add profiles');
    this.contentEl.createEl('p', { text: 'One per line. Handles, @handles or full x.com URLs all work.' });
    const ta = this.contentEl.createEl('textarea');
    ta.style.width = '100%';
    ta.rows = 14;
    ta.focus();
    const row = this.contentEl.createDiv({ cls: 'modal-button-container' });
    row.createEl('button', { text: 'Cancel' }).onclick = () => this.close();
    row.createEl('button', { text: 'Add', cls: 'mod-cta' }).onclick = async () => {
      const { handleFromUrl } = this.plugin.lib();
      const seen = new Set(this.plugin.settings.profiles.map((p) => p.handle.toLowerCase()));
      let added = 0;
      for (const line of ta.value.split('\n')) {
        const raw = line.trim();
        if (!raw) continue;
        const handle = (handleFromUrl(raw) || raw.replace(/^@/, '')).split(/[/?]/)[0];
        if (!handle || seen.has(handle.toLowerCase())) continue;
        seen.add(handle.toLowerCase());
        this.plugin.settings.profiles.push({ handle, timeline: '', note: `@${handle}`, tags: '', enabled: true });
        added++;
      }
      await this.plugin.saveSettings();
      this.close();
      new Notice(`Added ${added} profiles.`, 6000);
      this.onDone();
    };
  }
}

/* ---------------- settings tab ---------------- */

class ArchXSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();

    new Setting(containerEl)
      .setName('gallery-dl')
      .setDesc(s.galleryDlPath)
      .addButton((b) => b.setButtonText('Check setup').onClick(() => this.plugin.setup()))
      .addButton((b) => b.setButtonText('Update').onClick(() => this.plugin.updateGalleryDl()));

    containerEl.createEl('h3', { text: `Profiles (${s.profiles.length})` });

    new Setting(containerEl)
      .setName('Add profiles')
      .setDesc('Paste a list — handles or URLs, one per line.')
      .addButton((b) => b.setButtonText('Paste a list').setCta().onClick(() => new BulkAddModal(this.app, this.plugin, () => this.display()).open()))
      .addButton((b) => b.setButtonText('Sync all now').onClick(() => this.plugin.enqueue(() => this.plugin.syncAll())));

    const list = containerEl.createDiv();
    list.style.maxHeight = '320px';
    list.style.overflowY = 'auto';
    s.profiles.forEach((p, i) => {
      new Setting(list)
        .setName(`@${p.handle}`)
        .addToggle((t) => t.setTooltip('Include in Sync all').setValue(p.enabled !== false)
          .onChange(async (v) => { p.enabled = v; await save(); }))
        .addDropdown((d) => d.addOptions({ '': 'Default timeline', posts: 'Posts', tweets: 'Tweets tab', replies: 'With replies (cookies)', media: 'Media only (cookies)', likes: 'Likes (cookies)' })
          .setValue(p.timeline || '').onChange(async (v) => { p.timeline = v; await save(); }))
        .addButton((b) => b.setIcon('refresh-cw').setTooltip('Sync this profile')
          .onClick(() => this.plugin.enqueue(async () => {
            const n = await this.plugin.syncProfile(p);
            new Notice(`${n} new notes from @${p.handle}.`, 6000);
          })))
        .addButton((b) => b.setIcon('trash').setTooltip('Remove')
          .onClick(async () => { s.profiles.splice(i, 1); await save(); this.display(); }));
    });

    containerEl.createEl('h3', { text: 'What to fetch' });

    new Setting(containerEl).setName('Default timeline')
      .addDropdown((d) => d.addOptions({ posts: 'Posts', tweets: 'Tweets tab', replies: 'With replies (cookies)', media: 'Media only (cookies)', likes: 'Likes (cookies)' })
        .setValue(s.timeline).onChange(async (v) => { s.timeline = v; await save(); }));

    new Setting(containerEl).setName('Most recent posts per profile')
      .setDesc('0 fetches the whole timeline. Start small: X rate-limits hard and 150 profiles is a lot of requests.')
      .addText((t) => t.setValue(String(s.maxPerProfile)).onChange(async (v) => { s.maxPerProfile = Number(v) || 0; await save(); }));

    new Setting(containerEl).setName('Seconds between requests')
      .setDesc('The single most effective setting against rate limiting.')
      .addText((t) => t.setValue(String(s.sleepRequest)).onChange(async (v) => { s.sleepRequest = Number(v) || 0; await save(); }));

    new Setting(containerEl).setName('Include reposts')
      .addToggle((t) => t.setValue(s.retweets).onChange(async (v) => { s.retweets = v; await save(); }));
    new Setting(containerEl).setName('Include replies')
      .addToggle((t) => t.setValue(s.replies).onChange(async (v) => { s.replies = v; await save(); }));
    new Setting(containerEl).setName('Include quoted posts')
      .addToggle((t) => t.setValue(s.quoted).onChange(async (v) => { s.quoted = v; await save(); }));
    new Setting(containerEl).setName('Include text-only posts')
      .setDesc('Off makes this a media archiver only — gallery-dl skips posts with no image or video.')
      .addToggle((t) => t.setValue(s.textTweets).onChange(async (v) => { s.textTweets = v; await save(); }));

    containerEl.createEl('h3', { text: 'Notes' });

    const TOKENS = 'Tokens: {{handle}} {{author}} {{date}} {{year}} {{month}}';

    new Setting(containerEl).setName('Archive root')
      .setDesc('The folder the "archive root" modes below are relative to.')
      .addText((t) => t.setValue(s.archiveRoot).onChange(async (v) => { s.archiveRoot = v.trim(); await save(); }));

    new Setting(containerEl).setName('Where profile notes go')
      .addDropdown((d) => d.addOptions({
        specified: 'One folder',
        perProfile: 'A folder per profile',
        root: 'The archive root',
        subfolder: 'Subfolder under the archive root',
        vault: 'Vault root',
      }).setValue(s.profileLocationMode).onChange(async (v) => { s.profileLocationMode = v; await save(); this.display(); }));

    if (s.profileLocationMode === 'subfolder') {
      new Setting(containerEl).setName('Profile subfolder').setDesc(TOKENS)
        .addText((t) => t.setValue(s.profileSubfolder).onChange(async (v) => { s.profileSubfolder = v.trim(); await save(); }));
    }
    if (s.profileLocationMode === 'specified' || s.profileLocationMode === 'perProfile') {
      new Setting(containerEl).setName('Profile folder').setDesc(TOKENS)
        .addText((t) => t.setValue(s.profileFolder).onChange(async (v) => { s.profileFolder = v.trim(); await save(); }));
    }

    new Setting(containerEl).setName('Where post notes go')
      .setDesc('"Same folder" and "Subfolder" are relative to the profile note.')
      .addDropdown((d) => d.addOptions({
        specified: 'One folder',
        perProfile: 'A folder per profile',
        same: 'Same folder as the profile note',
        subfolder: 'Subfolder beside the profile note',
        vault: 'Vault root',
      }).setValue(s.postLocationMode).onChange(async (v) => { s.postLocationMode = v; await save(); this.display(); }));

    if (s.postLocationMode === 'subfolder') {
      new Setting(containerEl).setName('Post subfolder').setDesc(TOKENS)
        .addText((t) => t.setValue(s.postSubfolder).onChange(async (v) => { s.postSubfolder = v.trim(); await save(); }));
    }
    if (s.postLocationMode === 'specified' || s.postLocationMode === 'perProfile') {
      new Setting(containerEl).setName('Post folder').setDesc(TOKENS)
        .addText((t) => t.setValue(s.postFolder).onChange(async (v) => { s.postFolder = v.trim(); await save(); }));
    }

    // Shows exactly where the next sync will put things. Two folder settings
    // with five modes each is easy to get wrong silently.
    const sample = { handle: 'example' };
    const pf = this.plugin.profileFolderFor(sample);
    new Setting(containerEl).setName('For @example, that is')
      .setDesc(`Profile note: ${pf || '(vault root)'}/@example.md\nPost notes: ${this.plugin.postFolderFor(sample, pf) || '(vault root)'}/`);
    new Setting(containerEl).setName('Post note name')
      .setDesc('Tokens: {{author}} {{authorName}} {{date}} {{id}} {{excerpt}}')
      .addText((t) => t.setValue(s.postNoteNameTemplate).onChange(async (v) => { s.postNoteNameTemplate = v; await save(); }));
    new Setting(containerEl).setName('Write url as a markdown link')
      .setDesc('On gives [Link](https://x.com/…), matching the hand-made notes. Off gives a bare URL. A sync overwrites whichever form a note already had, so decide before syncing notes you made by hand.')
      .addToggle((t) => t.setValue(s.urlAsLink).onChange(async (v) => { s.urlAsLink = v; await save(); }));

    new Setting(containerEl).setName('x-author links to the profile note')
      .setDesc('On writes [[@handle]] on post notes, so one property both names the author and gets you there. Off writes a plain @handle.')
      .addToggle((t) => t.setValue(s.authorAsLink).onChange(async (v) => { s.authorAsLink = v; await save(); }));

    new Setting(containerEl).setName('Post tags')
      .addText((t) => t.setValue(s.tags.join(', ')).onChange(async (v) => { s.tags = splitList(v); await save(); }));
    new Setting(containerEl).setName('Profile tags')
      .addText((t) => t.setValue(s.profileTags.join(', ')).onChange(async (v) => { s.profileTags = splitList(v); await save(); }));

    containerEl.createEl('h3', { text: 'Profile picture and header' });

    new Setting(containerEl).setName('Download the icon and banner')
      .setDesc('Saved beside the profile note and written into its icon and banner properties. The URLs come free with the metadata, so this costs two downloads per profile and no extra API calls.')
      .addToggle((t) => t.setValue(s.downloadProfileImages).onChange(async (v) => { s.downloadProfileImages = v; await save(); this.display(); }));

    if (s.downloadProfileImages) {
      new Setting(containerEl).setName('Where the images go')
        .addDropdown((d) => d.addOptions({
          subfolder: 'Subfolder beside the profile note',
          same: 'Same folder as the profile note',
          specified: 'One folder',
          perProfile: 'A folder per profile',
          vault: 'Vault root',
        }).setValue(s.profileImageLocationMode).onChange(async (v) => { s.profileImageLocationMode = v; await save(); this.display(); }));

      if (s.profileImageLocationMode === 'subfolder') {
        new Setting(containerEl).setName('Image subfolder').setDesc(TOKENS)
          .addText((t) => t.setValue(s.profileImageSubfolder).onChange(async (v) => { s.profileImageSubfolder = v.trim(); await save(); }));
      }
      if (s.profileImageLocationMode === 'specified' || s.profileImageLocationMode === 'perProfile') {
        new Setting(containerEl).setName('Image folder').setDesc(TOKENS)
          .addText((t) => t.setValue(s.profileImageFolder).onChange(async (v) => { s.profileImageFolder = v.trim(); await save(); }));
      }

      new Setting(containerEl).setName('Icon file name').setDesc('Tokens: {{author}} {{handle}}')
        .addText((t) => t.setValue(s.iconNameTemplate).onChange(async (v) => { s.iconNameTemplate = v; await save(); }));
      new Setting(containerEl).setName('Banner file name').setDesc('Tokens: {{author}} {{handle}}')
        .addText((t) => t.setValue(s.bannerNameTemplate).onChange(async (v) => { s.bannerNameTemplate = v; await save(); }));

      new Setting(containerEl).setName('Convert to WebP')
        .setDesc('X serves JPEG. WebP is roughly half the size. An image that would come out larger keeps its original format.')
        .addDropdown((d) => d.addOptions({ webp: 'Convert to WebP', keep: 'Keep what X serves' })
          .setValue(s.profileImageFormat).onChange(async (v) => { s.profileImageFormat = v; await save(); }));

      new Setting(containerEl).setName('Re-download on every sync')
        .setDesc('Off means an image already on disk is left alone, which is what makes a re-run of every profile cheap. Turn it on once to pick up changed avatars, then turn it off.')
        .addToggle((t) => t.setValue(s.refreshProfileImages).onChange(async (v) => { s.refreshProfileImages = v; await save(); }));

      const sampleP = { handle: 'example' };
      const pf2 = this.plugin.profileFolderFor(sampleP);
      new Setting(containerEl).setName('For @example, that is')
        .setDesc(`${this.plugin.imageFolderFor(sampleP, pf2) || '(vault root)'}/${this.plugin.imageStem(s.iconNameTemplate, sampleP)}.webp`);
    }

    containerEl.createEl('h3', { text: 'Access' });

    const browsers = this.plugin.detectBrowsers();
    new Setting(containerEl).setName('Cookies from browser')
      .setDesc('Posts works without cookies via a guest token. Replies, media and likes do not. Cookies are read at run time and never stored here.')
      .addDropdown((d) => {
        d.addOption('', 'None');
        for (const b of browsers) d.addOption(b.name, b.name);
        d.setValue(s.cookiesFromBrowser).onChange(async (v) => { s.cookiesFromBrowser = v; await save(); });
      });
    new Setting(containerEl).setName('Or a cookies.txt file')
      .addText((t) => t.setValue(s.cookiesFile).onChange(async (v) => { s.cookiesFile = v.trim(); await save(); }));
    new Setting(containerEl).setName('Remember what has been fetched')
      .setDesc('Keeps a download archive so re-running a profile is cheap.')
      .addToggle((t) => t.setValue(s.useDownloadArchive).onChange(async (v) => { s.useDownloadArchive = v; await save(); }));
    new Setting(containerEl).setName('Extra gallery-dl arguments')
      .addText((t) => t.setValue(s.extraArgs).onChange(async (v) => { s.extraArgs = v; await save(); }));
  }
}

module.exports = ArchXArchivePlugin;
