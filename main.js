'use strict';

const { Plugin, PluginSettingTab, Setting, Notice, Modal, TFile, TFolder, normalizePath } = require('obsidian');
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
  archiveRoot: 'X/Profiles',
  profileNoteInOwnFolder: true,
  postNoteNameTemplate: '{{author}} — {{date}} — {{excerpt}}',
  tags: ['x-post'],
  profileTags: ['x-profile'],
  postNoteOrder: 'dl-ed, url, x-author, x-author-name, x-post-id, published, x-profile, media, likes, reposts, replies, tags',
  profileNoteOrder: 'url, x-author, x-author-name, followers, posts, joined, count, x-synced, tags',

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
      range: max ? `1-${max}` : '',
      archiveFile: this.settings.useDownloadArchive ? this.archivePath() : '',
    }, 0);

    if (r.code !== 0 && !r.stdout.trim()) {
      throw new Error(this.explain(r.stderr) || `gallery-dl exited ${r.code}`);
    }
    const posts = groupByTweet(parseDumpJson(r.stdout));
    this.log(`@${profile.handle}: ${posts.length} posts`);
    if (!posts.length) return 0;

    const folder = await this.folderFor(profile);
    await this.writeProfileNote(profile, posts, folder);

    let written = 0;
    for (const post of posts) {
      if (await this.writePostNote(post, profile, folder)) written++;
    }
    return written;
  }

  // gallery-dl's failures are mostly one of three, and each has a different fix.
  explain(stderr) {
    const s = String(stderr || '');
    if (/401|Unauthorized|login|authorization/i.test(s)) return 'X refused the request — cookies are missing or stale. Log in to X in your browser, then sync again.';
    if (/429|rate.?limit/i.test(s)) return 'Rate-limited by X. Raise "Seconds between requests" and try a smaller batch.';
    if (/404|Not Found|suspended/i.test(s)) return 'Profile not found, suspended, or protected.';
    return s.trim().split('\n').filter(Boolean).slice(-1)[0] || '';
  }

  archivePath() { return path.join(this.pluginDir(), 'seen.sqlite3'); }

  /* ---------------- note writing ---------------- */

  async folderFor(profile) {
    const { sanitizeName } = this.lib();
    const root = this.settings.archiveRoot || 'X/Profiles';
    const folder = this.settings.profileNoteInOwnFolder
      ? `${root}/${sanitizeName('@' + profile.handle)}`
      : root;
    await this.ensureFolder(folder);
    return folder;
  }

  async writeProfileNote(profile, posts, folder) {
    const { renderProfile, sanitizeName } = this.lib();
    const first = posts.find((p) => p.meta && (p.meta.user || p.meta.author));
    const meta = first ? first.meta : { user: { name: profile.handle } };
    const name = sanitizeName(profile.note || `@${profile.handle}`);
    const notePath = normalizePath(`${folder}/${name}.md`);
    const body = renderProfile(meta, {
      tags: splitList(profile.tags || this.settings.profileTags.join(', ')),
      count: posts.length,
      syncedAt: new Date().toISOString().slice(0, 19) + 'Z',
      order: splitList(this.settings.profileNoteOrder),
    });
    const existing = this.app.vault.getAbstractFileByPath(notePath);
    if (existing instanceof TFile) await this.app.vault.modify(existing, body);
    else await this.app.vault.create(notePath, body);
    return notePath;
  }

  // Returns true when a note was created. An existing post is left completely
  // alone: X counts change constantly, and rewriting 150 profiles' worth of
  // notes on every sync to update a like count would churn the whole vault.
  async writePostNote(post, profile, folder) {
    const { renderPost, postNoteName } = this.lib();
    const name = postNoteName(post, this.settings.postNoteNameTemplate);
    const notePath = normalizePath(`${folder}/${name}.md`);
    if (this.app.vault.getAbstractFileByPath(notePath)) return false;
    if (this.findByPostId(post.id)) return false;

    const body = renderPost(post, {
      tags: splitList(profile.tags || this.settings.tags.join(', ')),
      profileLink: `[[${profile.note || '@' + profile.handle}]]`,
      order: splitList(this.settings.postNoteOrder),
      mediaLinks: [],
      embeds: [],
    });
    const created = await this.app.vault.create(notePath, body);
    // metadataCache has not seen the new note yet, so the index has to be told.
    if (this.postIndex) this.postIndex.set(String(post.id), created);
    return true;
  }

  // A post found on two timelines -- a reply archived from both people -- would
  // otherwise be written twice under two names. The id is the identity, not the
  // filename, because the name template can change.
  //
  // The index is built ONCE per sync run and updated as notes are written.
  // Scanning every markdown file per post is what the obvious version does, and
  // at 150 profiles x 200 posts that is 30,000 full-vault scans.
  buildPostIndex() {
    const index = new Map();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const id = this.app.metadataCache.getFileCache(file)?.frontmatter?.['x-post-id'];
      if (id) index.set(String(id), file);
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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    if (!Array.isArray(this.settings.profiles)) this.settings.profiles = [];
    if (!Array.isArray(this.settings.tags)) this.settings.tags = [];
    if (!Array.isArray(this.settings.profileTags)) this.settings.profileTags = [];
  }

  async saveSettings() { await this.saveData(this.settings); }
}

/* ---------------- helpers ---------------- */

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
        .addDropdown((d) => d.addOptions({ '': 'Default timeline', posts: 'Posts', replies: 'With replies', media: 'Media only', likes: 'Likes' })
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
      .addDropdown((d) => d.addOptions({ posts: 'Posts', replies: 'With replies', media: 'Media only', likes: 'Likes' })
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

    new Setting(containerEl).setName('Archive folder')
      .addText((t) => t.setValue(s.archiveRoot).onChange(async (v) => { s.archiveRoot = v.trim(); await save(); }));
    new Setting(containerEl).setName('A folder per profile')
      .addToggle((t) => t.setValue(s.profileNoteInOwnFolder).onChange(async (v) => { s.profileNoteInOwnFolder = v; await save(); }));
    new Setting(containerEl).setName('Post note name')
      .setDesc('Tokens: {{author}} {{authorName}} {{date}} {{id}} {{excerpt}}')
      .addText((t) => t.setValue(s.postNoteNameTemplate).onChange(async (v) => { s.postNoteNameTemplate = v; await save(); }));
    new Setting(containerEl).setName('Post tags')
      .addText((t) => t.setValue(s.tags.join(', ')).onChange(async (v) => { s.tags = splitList(v); await save(); }));
    new Setting(containerEl).setName('Profile tags')
      .addText((t) => t.setValue(s.profileTags.join(', ')).onChange(async (v) => { s.profileTags = splitList(v); await save(); }));

    containerEl.createEl('h3', { text: 'Access' });

    const browsers = this.plugin.detectBrowsers();
    new Setting(containerEl).setName('Cookies from browser')
      .setDesc('X shows almost nothing to a logged-out client. Cookies are read at run time and never stored here.')
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
