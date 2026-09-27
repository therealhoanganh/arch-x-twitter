'use strict';

const { Plugin, PluginSettingTab, Setting, Notice, Modal, TFile, TFolder, normalizePath, requestUrl } = require('obsidian');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const DEFAULT_SETTINGS = {
  // --- what to archive ---
  // Two lists, deliberately. `profiles` is a handful of accounts that each need
  // their own settings and get their own row; `bulkList` is the long tail --
  // hundreds of handles sharing one set of options, kept as text because
  // hundreds of rows makes the settings tab unusable to load and to search.
  // Each entry: { handle, timeline, note, tags, enabled }
  profiles: [],
  bulkList: '',
  bulkTimeline: '',
  bulkTags: '',
  bulkMaxPerProfile: '',
  timeline: 'posts',        // posts | replies | media | likes
  retweets: true,
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

  // Bumped whenever the note templates or folder layout change in a way that a
  // saved config must not shadow. See resetTemplateSettings.
  settingsVersion: 2,
};

// Settings that describe WHAT THE PLUGIN WRITES rather than a preference the
// user tuned. A saved copy of these predating a template change is a leftover,
// not a choice, and `Object.assign(defaults, saved)` lets it shadow every new
// default silently -- which is exactly how several rounds of template changes
// appeared to do nothing at all.
// Run by testCookies with this computer's gallery-dl Python: loads the browser's
// cookies for x.com as a sync would and says whether an X login is among them.
const COOKIE_TEST = [
  'import sys, json, logging',
  'logging.disable(logging.CRITICAL)',
  'from gallery_dl import cookies',
  'try:',
  '    jar = cookies.load_cookies((sys.argv[1], None, None, None, ".x.com")) or []',
  '    ours = lambda d: d.lstrip(".") in ("x.com", "twitter.com") or d.endswith((".x.com", ".twitter.com"))',
  '    names = [c.name for c in jar if ours(c.domain)]',
  '    print(json.dumps({"ok": True, "count": len(names), "loggedIn": "auth_token" in names}))',
  'except Exception as e:',
  '    print(json.dumps({"ok": False, "error": type(e).__name__ + ": " + str(e)}))',
].join('\n');

const TEMPLATE_SETTINGS = [
  'profileNoteOrder', 'postNoteOrder',
  'archiveRoot', 'profileLocationMode', 'profileSubfolder', 'profileFolder',
  'postLocationMode', 'postSubfolder', 'postFolder',
  'profileImageLocationMode', 'profileImageSubfolder', 'profileImageFolder',
  'iconNameTemplate', 'bannerNameTemplate',
  'tags', 'profileTags', 'urlAsLink', 'authorAsLink',
];

class ArchXArchivePlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.procs = new Set();
    this.queue = Promise.resolve();

    this.addCommand({ id: 'sync-all-profiles', name: 'Sync All Profiles', callback: () => this.enqueue(() => this.syncAll()) });
    this.addCommand({ id: 'sync-individual', name: 'Sync Individual Profiles Only', callback: () => this.enqueue(() => this.syncList(this.individualProfiles(), 'individual profiles')) });
    this.addCommand({ id: 'sync-bulk', name: 'Sync the Bulk List Only', callback: () => this.enqueue(() => this.syncList(this.bulkProfiles(), 'the bulk list')) });
    this.addCommand({ id: 'profile-notes-only', name: 'Create Profile Notes Only (No Posts)', callback: () => this.enqueue(() => this.syncList(this.allProfiles(), 'every list', { profileOnly: true })) });
    this.addCommand({ id: 'archive-url', name: 'Archive an X Post or Profile by URL…', callback: () => this.promptForUrl() });
    this.addCommand({ id: 'setup', name: 'Set Up External Tools', callback: () => this.setup() });

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
    this.dropLibFromRequireCache(dir);
    this._lib = require(path.join(dir, 'index.js'));
    return this._lib;
  }

  // Electron's require() caches by resolved path, and disabling and re-enabling
  // a plugin does NOT clear that cache. Without this, editing lib/ and reloading
  // the plugin silently keeps running the OLD code -- which makes the disk
  // fallback, whose entire purpose is the edit-and-reload loop, useless. Only a
  // full app reload picked changes up, and it looked exactly like the edit had
  // not been saved.
  //
  // The plugin folder is often a symlink into the repo during development, and
  // require resolves symlinks, so the cached keys live under the REAL path, not
  // the one under .obsidian. Both are matched.
  dropLibFromRequireCache(dir) {
    if (typeof require === 'undefined' || !require.cache) return;
    const roots = [dir];
    try { roots.push(fs.realpathSync(dir)); } catch (_) { /* not a link, or gone */ }
    let dropped = 0;
    for (const key of Object.keys(require.cache)) {
      if (roots.some((root) => key.startsWith(root + path.sep))) {
        delete require.cache[key];
        dropped++;
      }
    }
    if (dropped) this.log(`reloaded ${dropped} lib module(s) from disk`);
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

  // A configured absolute path stops working for reasons that have nothing to do
  // with the user: the plugin folder is renamed, a vault moves, BRAT reinstalls
  // elsewhere. A Python venv is worse than most -- it hardcodes its own path in
  // every script's shebang, so it fails with "bad interpreter" rather than
  // "not found". Re-detect once instead of reporting a broken install.
  // This computer's own copy, in the plugin's bin/venv, when it has one; else the
  // setting (a gallery-dl installed elsewhere, such as Homebrew's). The vaults are
  // mirrored between the Mac and the PC, and a path saved on one (/home/… on the
  // PC) does not exist on the other, so the setting alone flipped back and forth
  // with a "gallery-dl moved" notice at every switch (0.11.4). bin/venv is never
  // mirrored: each computer builds its own.
  galleryDlBin() {
    const own = path.join(this.binDir(), 'venv', process.platform === 'win32' ? 'Scripts' : 'bin', this.exeName('gallery-dl'));
    return fs.existsSync(own) ? own : this.settings.galleryDlPath || 'gallery-dl';
  }

  async ensureGalleryDl() {
    const bin = this.galleryDlBin();
    const probe = await this.run(bin, ['--version'], 15000).catch((e) => ({ code: 1, stderr: String(e.message) }));
    if (probe.code === 0) return true;
    this.log('configured gallery-dl did not run:', (probe.stderr || '').trim().split('\n')[0]);
    const found = await this.findBinary('gallery-dl');
    if (!found.found) return false;
    this.settings.galleryDlPath = found.path;
    await this.saveSettings();
    this.log('gallery-dl re-detected at', found.path);
    new Notice(`gallery-dl moved; using ${found.path}`, 8000);
    return true;
  }

  async runGalleryDl(target, opts, timeoutMs) {
    // Marked checked only once the check passes (0.11.4). It used to be marked
    // before, so after one failure every later click ran the missing file and
    // threw a bare "spawn … ENOENT" instead of saying what to do.
    if (!this._galleryDlChecked) {
      if (!(await this.ensureGalleryDl())) {
        throw new Error('gallery-dl is not installed on this computer. Run "Set Up External Tools" from the command palette.');
      }
      this._galleryDlChecked = true;
    }
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
    const r = await this.run(this.galleryDlBin(), args, timeoutMs);
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
    r.uv = process.platform === 'linux' ? await this.findBinary('uv', ['--version']) : { found: false };
    r.ffmpeg = await this.findBinary('ffmpeg', ['-version']);
    r.browsers = this.detectBrowsers();
    r.cookies = this.settings.cookiesFromBrowser ? await this.testCookies(this.settings.cookiesFromBrowser) : null;
    return r;
  }

  // Whether gallery-dl can read an X login from the browser (0.11.5). It loads the
  // browser's cookies the way a sync does, through gallery-dl's own Python, so a
  // keyring that cannot be read fails here with the reason instead of a sync
  // quietly running logged out. Needs this computer's own gallery-dl venv.
  async testCookies(browser) {
    const py = path.join(path.dirname(this.galleryDlBin()), this.exeName('python'));
    if (!fs.existsSync(py)) return { ok: false, error: 'gallery-dl is not installed in this plugin yet' };
    const r = await this.run(py, ['-c', COOKIE_TEST, browser], 30000).catch((e) => ({ code: 1, stdout: '', stderr: e.message }));
    try {
      return JSON.parse((r.stdout || '').trim().split('\n').pop());
    } catch (_) {
      return { ok: false, error: (r.stderr || 'no answer').trim().split('\n').pop() };
    }
  }

  async autoConfigure(report) {
    const filled = [];
    // This plugin's own venv is found by galleryDlBin() on each computer, so its
    // path is not written into the synced setting, where it would name one
    // computer's folder on the other (0.11.5).
    const own = report.gallerydl.found && report.gallerydl.path.startsWith(path.join(this.binDir(), 'venv'));
    if (report.gallerydl.found && !own && path.isAbsolute(report.gallerydl.path) && report.gallerydl.path !== this.settings.galleryDlPath) {
      this.settings.galleryDlPath = report.gallerydl.path;
      filled.push(`gallery-dl path → ${report.gallerydl.path}`);
    }
    if (!this.settings.cookiesFile && !this.settings.cookiesFromBrowser && report.browsers.length) {
      const usable = report.browsers.find((b) => b.name !== 'safari') || report.browsers[0];
      this.settings.cookiesFromBrowser = usable.name;
      filled.push(`Cookies from Browser → ${usable.name}`);
    }
    if (filled.length) await this.saveSettings();
    return filled;
  }

  // gallery-dl publishes NO prebuilt binaries -- checked against the last eight
  // releases, every one of which has zero release assets. The yt-dlp trick of
  // downloading a standalone executable does not transfer. A private venv is the
  // closest equivalent: self-contained, removable with the plugin folder, and it
  // does not touch the user's system Python.
  // On Linux gallery-dl reads Chrome's cookies through the keyring, which needs
  // secretstorage; without it most cookies stay encrypted and only Posts works (0.11.4).
  galleryDlPackages() {
    return process.platform === 'linux' ? ['gallery-dl', 'secretstorage'] : ['gallery-dl'];
  }

  async installGalleryDl() {
    const python = (await this.findBinary('python3', ['--version'])).path || 'python3';
    const venv = path.join(this.binDir(), 'venv');
    const pip = path.join(venv, process.platform === 'win32' ? 'Scripts' : 'bin', this.exeName('pip'));
    const bin = path.join(venv, process.platform === 'win32' ? 'Scripts' : 'bin', this.exeName('gallery-dl'));

    const notice = new Notice('Creating a private Python environment…', 0);
    try {
      fs.mkdirSync(this.binDir(), { recursive: true });
      let r = await this.run(python, ['-m', 'venv', venv], 180000);
      // Ubuntu's Python cannot make a venv until python3-venv is installed, which
      // needs sudo; uv (astral.sh) makes the same venv without it (0.11.4).
      const uv = r.code === 0 ? null : await this.findBinary('uv', ['--version']);
      if (r.code !== 0 && uv && uv.found) {
        this.log('python -m venv failed, using uv:', r.stderr.trim().split('\n')[0]);
        fs.rmSync(venv, { recursive: true, force: true });
        r = await this.run(uv.path, ['venv', '--python', python, venv], 180000);
        if (r.code !== 0) throw new Error(`uv venv failed: ${r.stderr.trim().split('\n').slice(-2).join(' ')}`);
        notice.setMessage('Installing gallery-dl…');
        const py = path.join(venv, process.platform === 'win32' ? 'Scripts' : 'bin', this.exeName('python'));
        r = await this.run(uv.path, ['pip', 'install', '--python', py, '--upgrade', ...this.galleryDlPackages()], 300000);
        if (r.code !== 0) throw new Error(`uv pip failed: ${r.stderr.trim().split('\n').slice(-2).join(' ')}`);
      } else {
        if (r.code !== 0) throw new Error(`venv failed: ${r.stderr.trim().split('\n').slice(-2).join(' ')}`);
        notice.setMessage('Installing gallery-dl…');
        r = await this.run(pip, ['install', '--upgrade', ...this.galleryDlPackages()], 300000);
        if (r.code !== 0) throw new Error(`pip failed: ${r.stderr.trim().split('\n').slice(-2).join(' ')}`);
      }

      const check = await this.run(bin, ['--version'], 20000);
      notice.hide();
      if (check.code !== 0) { new Notice('gallery-dl installed but would not run.', 10000); return false; }

      this._galleryDlChecked = false;
      new Notice(`gallery-dl ${check.stdout.trim()} installed.`, 8000);
      return true;
    } catch (e) {
      notice.hide();
      const hint = process.platform === 'darwin' ? 'brew install gallery-dl'
        : process.platform === 'linux' ? 'sudo apt install python3-venv, then Set Up External Tools again (or install uv)'
        : 'pip install gallery-dl';
      new Notice(`Could not install gallery-dl: ${e.message}\nTry: ${hint}`, 15000);
      return false;
    }
  }

  async updateGalleryDl() {
    const bin = this.galleryDlBin();
    const venvPip = bin.includes(path.join('bin', 'venv')) || bin.includes(`${path.sep}venv${path.sep}`)
      ? path.join(path.dirname(bin), this.exeName('pip'))
      : null;
    const notice = new Notice('Updating gallery-dl…', 0);
    let r = { code: 1, stderr: 'not a managed install' };
    if (venvPip && fs.existsSync(venvPip)) {
      r = await this.run(venvPip, ['install', '--upgrade', ...this.galleryDlPackages()], 300000);
    } else if (venvPip) {
      // A venv made by uv has no pip of its own (0.11.4).
      const uv = await this.findBinary('uv', ['--version']);
      if (uv.found) r = await this.run(uv.path, ['pip', 'install', '--python', path.join(path.dirname(bin), this.exeName('python')), '--upgrade', ...this.galleryDlPackages()], 300000);
    }
    notice.hide();
    if (r.code === 0) new Notice('gallery-dl is up to date.', 6000);
    else new Notice('Update it the way you installed it (brew upgrade gallery-dl, or pip install -U gallery-dl).', 12000);
  }

  // Finds the tools, fills the settings in, and opens the popup that installs
  // or updates each one (0.11.5, laid out like After Clipping's).
  async setup() {
    const notice = new Notice('Looking for gallery-dl, Python, ffmpeg, browsers…', 0);
    const { report, filled } = await this.checkTools();
    notice.hide();
    new SetupModal(this.app, this, report, filled).open();
  }

  async checkTools() {
    let report = await this.detectTools();
    const filled = await this.autoConfigure(report);
    // A browser picked just now has not been tested yet.
    if (!report.cookies && this.settings.cookiesFromBrowser) report.cookies = await this.testCookies(this.settings.cookiesFromBrowser);
    this.log('tool report', report, 'filled', filled);
    return { report, filled };
  }

  /* ---------------- syncing ---------------- */

  // The bulk list is a plain newline-separated block of handles sharing one set
  // of options. Hundreds of individual rows made the settings tab unusable, so
  // the many live here and the few that need their own settings stay as rows.
  // The list in settings, or the text given (the Manage popup counts as you type).
  bulkProfiles(text = this.settings.bulkList) {
    const { handleFromUrl } = this.lib();
    const seen = new Set();
    const out = [];
    for (const line of String(text || '').split('\n')) {
      const raw = line.trim();
      if (!raw || raw.startsWith('#')) continue;
      const handle = (handleFromUrl(raw) || raw.replace(/^@/, '')).split(/[/?]/)[0];
      if (!handle || seen.has(handle.toLowerCase())) continue;
      seen.add(handle.toLowerCase());
      out.push({
        handle,
        note: `@${handle}`,
        timeline: this.settings.bulkTimeline || '',
        tags: this.settings.bulkTags || '',
        maxPerProfile: this.settings.bulkMaxPerProfile === '' || this.settings.bulkMaxPerProfile == null
          ? undefined
          : Number(this.settings.bulkMaxPerProfile),
      });
    }
    return out;
  }

  individualProfiles() {
    return (this.settings.profiles || []).filter((p) => p.enabled !== false && p.handle);
  }

  // A handle in both lists is synced once. The individual row wins, because it
  // is the one carrying deliberate per-profile settings.
  allProfiles() {
    const rows = this.individualProfiles();
    const named = new Set(rows.map((p) => p.handle.toLowerCase()));
    return [...rows, ...this.bulkProfiles().filter((p) => !named.has(p.handle.toLowerCase()))];
  }

  async syncList(list, label, opts = {}) {
    const active = list.filter((p) => p.handle);
    if (!active.length) return new Notice(`No profiles in ${label}.`, 8000);
    this.buildPostIndex();
    const what = opts.profileOnly ? 'Fetching profile notes' : 'Syncing';
    const notice = new Notice(`${what} 0/${active.length}…`, 0);
    let written = 0, failed = 0;
    const problems = [];
    for (let i = 0; i < active.length; i++) {
      notice.setMessage(`${what} ${i + 1}/${active.length}\n@${active[i].handle}`);
      try {
        written += await this.syncProfile(active[i], opts);
      } catch (e) {
        failed++;
        problems.push(`@${active[i].handle}: ${e.message}`);
        console.error('[arch-x]', active[i].handle, e);
      }
    }
    notice.hide();
    if (problems.length) this.log('failures:\n' + problems.join('\n'));
    new Notice(
      opts.profileOnly
        ? `Done. ${active.length - failed} profile notes from ${label}.` + (failed ? ` ${failed} failed.` : '')
        : `Done. ${written} new notes from ${active.length} profiles in ${label}.` + (failed ? ` ${failed} failed — see the console.` : ''),
      12000
    );
  }

  async syncAll() { return this.syncList(this.allProfiles(), 'every list'); }

  // `profileOnly` writes the profile note and its images and no post notes.
  // X has no endpoint for "just this account's details" that gallery-dl exposes,
  // so one post is still fetched -- the author block rides along on every row --
  // but nothing is written from it. The download archive is skipped in that mode
  // so a later real sync does not consider that post already seen.
  async syncProfile(profile, opts = {}) {
    const { profileUrl, parseDumpJson, groupByTweet } = this.lib();
    const target = profileUrl(profile.handle, profile.timeline || this.settings.timeline);
    if (!target) throw new Error(`"${profile.handle}" is not a usable handle`);

    if (!this.postIndex) this.buildPostIndex();
    const max = opts.profileOnly ? 1 : (Number(profile.maxPerProfile ?? this.settings.maxPerProfile) || 0);
    const r = await this.runGalleryDl(target, {
      dumpJson: true,
      postRange: max ? `1-${max}` : '',
      archiveFile: !opts.profileOnly && this.settings.useDownloadArchive ? this.archivePath() : '',
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
    this.log(`@${profile.handle}: ${posts.length} posts${opts.profileOnly ? ' (profile note only)' : ''}`);
    if (!posts.length) return 0;

    const profileFolder = await this.folderFor(profile);
    await this.writeProfileNote(profile, posts, profileFolder);
    if (opts.profileOnly) return 0;

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
    if (/AuthRequired|authenticated cookies/i.test(s)) return 'That timeline needs a logged-in session. Pick a browser under "Cookies from Browser" in settings — Posts works without one, but replies, media and likes do not.';
    if (/401|Unauthorized|login|authorization/i.test(s)) return 'X refused the request — cookies are missing or stale. Log in to X in your browser, then sync again.';
    if (/429|rate.?limit/i.test(s)) return 'Rate-limited by X. Raise "Seconds between Requests" and try a smaller batch.';
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

    // A saved copy of the template settings shadows every new default. Reset
    // them once per settingsVersion bump, so a template change actually reaches
    // a vault that has been running this plugin -- which is every vault that
    // matters. Preferences the user really did tune (profiles, cookies, limits,
    // paths to binaries) are untouched.
    if ((saved.settingsVersion || 0) < DEFAULT_SETTINGS.settingsVersion) {
      this.resetTemplateSettings();
      this.settings.settingsVersion = DEFAULT_SETTINGS.settingsVersion;
      this.log('templates and folders reset to the', DEFAULT_SETTINGS.settingsVersion, 'defaults');
    }

    // Migrations run in memory. Without this they re-run on every load and, worse,
    // never reach data.json -- so the settings tab shows one thing and the file
    // says another until something unrelated triggers a save.
    if (JSON.stringify(this.settings) !== before) await this.saveData(this.settings);

    this.log('writing profile notes to', this.profileFolderFor({ handle: 'example' }));
    this.log(`${this.individualProfiles().length} individual + ${this.bulkProfiles().length} bulk profiles, ` +
      `${this.settings.maxPerProfile || 'all'} posts each, reposts ${this.settings.retweets ? 'on' : 'off'}`);
    this.log('profile template:', this.settings.profileNoteOrder);
    this.log('post template:', this.settings.postNoteOrder);
    if (!Array.isArray(this.settings.tags)) this.settings.tags = [];
    if (!Array.isArray(this.settings.profileTags)) this.settings.profileTags = [];
  }

  resetTemplateSettings() {
    for (const key of TEMPLATE_SETTINGS) {
      const value = DEFAULT_SETTINGS[key];
      this.settings[key] = Array.isArray(value) ? value.slice() : value;
    }
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
    const input = this.contentEl.createEl('input', { type: 'text', placeholder: 'https://x.com/someone or a post URL\u2026', attr: { 'aria-label': 'X post or profile address', spellcheck: 'false' } });
    input.style.width = '100%';
    input.focus();
    const go = () => { this.close(); this.onSubmit(input.value.trim()); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    const row = this.contentEl.createDiv({ cls: 'modal-button-container' });
    row.createEl('button', { text: 'Archive', cls: 'mod-cta' }).onclick = go;
  }
}

// The popup behind a long list's Manage… button, the same class in ARCH YT
// Playlists, X Twitter, After Clipping and Browser History (change all together). He chose it on 2026-09-27
// for every long list, the way Obsidian's own Excluded Files setting works: the
// settings tab shows one card with the count, and the list is edited here, in a
// box big enough to paste into. Only Cancel throws an edit away; Escape or the ✕
// keep it, since a long paste lost to one key is worse than a save not asked for.
class ListModal extends Modal {
  constructor(app, { title, hint, value, placeholder, count, onSave }) {
    super(app);
    Object.assign(this, { title, hint, value, placeholder, count, onSave });
    this.done = false;
  }

  onOpen() {
    const { contentEl } = this;
    this.titleEl.setText(this.title);
    this.modalEl.style.width = 'min(720px, 92vw)';
    if (this.hint) contentEl.createEl('p', { text: this.hint, cls: 'setting-item-description', attr: { style: 'margin-top:0;' } });
    const ta = contentEl.createEl('textarea', {
      attr: {
        spellcheck: 'false',
        'aria-label': this.title,
        placeholder: this.placeholder || '',
        style: 'width:100%; height:45vh; resize:vertical; font-family:var(--font-monospace); font-size:var(--font-ui-small); line-height:1.6;',
      },
    });
    ta.value = this.value;
    this.ta = ta;
    const foot = contentEl.createDiv({ attr: { style: 'display:flex; align-items:center; gap:8px; margin-top:12px;' } });
    const status = foot.createSpan({ cls: 'setting-item-description', attr: { style: 'flex:1; font-variant-numeric:tabular-nums;', 'aria-live': 'polite' } });
    const update = () => status.setText(this.count(ta.value));
    update();
    ta.addEventListener('input', update);
    const cancel = foot.createEl('button', { text: 'Cancel' });
    cancel.onclick = () => { this.done = true; this.close(); };
    const save = foot.createEl('button', { text: 'Save', cls: 'mod-cta' });
    save.onclick = async () => { this.done = true; this.close(); await this.onSave(ta.value); };
    // After Obsidian's own focus on the first button: the cursor goes to the end of the list.
    setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);
  }

  onClose() {
    if (!this.done && this.ta && this.ta.value !== this.value) {
      this.onSave(this.ta.value).then(() => new Notice(`${this.title}: saved.`));
    }
    this.contentEl.empty();
  }
}

// The setup popup (0.11.5), laid out like ARCH After Clipping's External Tools:
// one row per tool with a mark (● all right, ▲ worth a look, ○ missing, the word as
// a tooltip), what was found, and the button that fixes it.
class SetupModal extends Modal {
  constructor(app, plugin, report, filled) { super(app); this.plugin = plugin; this.report = report; this.filled = filled || []; }

  onOpen() {
    this.titleEl.setText('External Tools');
    this.render();
  }

  async refresh() {
    const { report, filled } = await this.plugin.checkTools();
    this.report = report;
    this.filled = filled;
    this.render();
  }

  row(label, state, detail, action) {
    const s = new Setting(this.contentEl).setName(label).setDesc(detail);
    const word = state === 'ok' ? 'All right' : state === 'warn' ? 'Worth a look' : 'Missing';
    s.nameEl.prepend(createSpan({
      text: state === 'ok' ? '● ' : state === 'warn' ? '▲ ' : '○ ',
      attr: { style: `color: var(--color-${state === 'ok' ? 'green' : state === 'warn' ? 'yellow' : 'red'});`, title: word, 'aria-label': word },
    }));
    if (action) s.addButton((b) => b.setButtonText(action.label).onClick(action.onClick));
    return s;
  }

  render() {
    const { contentEl } = this;
    const r = this.report;
    const s = this.plugin.settings;
    contentEl.empty();
    contentEl.createEl('p', { text: `${process.platform} ${process.arch}`, attr: { style: 'font-size:var(--font-ui-smaller); opacity:.6; margin:0 0 12px;' } });

    if (this.filled.length) {
      const box = contentEl.createDiv({ attr: { style: 'border-left:3px solid var(--color-green); padding:8px 12px; margin-bottom:14px; background:var(--background-secondary); border-radius:4px;' } });
      box.createEl('div', { text: 'Filled In for You', attr: { style: 'font-weight:600; margin-bottom:4px;' } });
      for (const line of this.filled) box.createEl('div', { text: line, attr: { style: 'font-size:var(--font-ui-smaller); opacity:.85; word-break:break-all;' } });
    }

    // gallery-dl
    const own = r.gallerydl.found && r.gallerydl.path.startsWith(path.join(this.plugin.binDir(), 'venv'));
    this.row('gallery-dl', r.gallerydl.found ? 'ok' : 'missing',
      r.gallerydl.found
        ? `${r.gallerydl.version}, ${own ? 'in this plugin’s own Python environment, built on this computer' : r.gallerydl.path}`
        : 'Fetches the posts. It has no ready-made download, so it is installed into a private Python environment in this plugin’s folder, one per computer; nothing outside the plugin is touched.',
      r.gallerydl.found
        ? { label: 'Update', onClick: async () => { await this.plugin.updateGalleryDl(); this.refresh(); } }
        : { label: 'Install', onClick: async () => { await this.plugin.installGalleryDl(); this.refresh(); } });

    // Python, needed only to build that environment
    const viaUv = !r.python.found || (r.uv && r.uv.found);
    this.row('Python', r.python.found ? 'ok' : (r.uv && r.uv.found ? 'ok' : 'missing'),
      r.python.found
        ? `${r.python.version}. Needed only to install gallery-dl.${process.platform === 'linux' && r.uv && r.uv.found ? ' On this computer uv builds the environment, since Ubuntu’s Python needs python3-venv for it.' : ''}`
        : viaUv && r.uv && r.uv.found ? 'Not found; uv will build the environment.' : 'Needed to install gallery-dl. Install Python 3, then Check Again.',
      null);

    // ffmpeg
    this.row('ffmpeg', r.ffmpeg.found ? 'ok' : 'warn',
      r.ffmpeg.found ? `${r.ffmpeg.version.split(' ').slice(0, 3).join(' ')}. ${r.ffmpeg.path}` : 'Needed to merge a video’s picture and sound. Posts and profiles work without it.',
      null);

    // Cookies: which browser, and whether its X login can be read. Said in so many
    // words (0.11.8): what is wrong, what fails because of it, and how to fix it and
    // see that it worked. His words, 2026-09-27: "You need to explicitly tell this in
    // the setup, so future me can know what's went wrong."
    const FAILS = 'only a profile’s Posts come back; replies, media, likes and protected accounts fail.';
    const c = r.cookies;
    let state = 'warn';
    let lines;
    if (s.cookiesFile) {
      state = fs.existsSync(s.cookiesFile) ? 'ok' : 'missing';
      lines = state === 'ok' ? [`Read from ${s.cookiesFile}.`] : [`No file at ${s.cookiesFile}.`, `Without cookies: ${FAILS}`, 'To fix: export the file again, or empty the cookies file in settings and pick a browser here.'];
    } else if (!s.cookiesFromBrowser) {
      lines = ['No browser picked, so gallery-dl runs logged out.', `Without a login: ${FAILS}`, 'To fix: pick the browser you use X in, then press Test.'];
    } else if (!c) {
      lines = [`Read from ${s.cookiesFromBrowser} at each sync. Not tested yet: press Test.`];
    } else if (c.ok && c.loggedIn) {
      state = 'ok';
      lines = [`Logged in to X in ${s.cookiesFromBrowser}. gallery-dl reads the login from ${s.cookiesFromBrowser} at each sync; nothing is stored.`];
    } else if (c.ok) {
      lines = [`${s.cookiesFromBrowser} is not logged in to X.`, `Without a login: ${FAILS}`, `To fix: open x.com in ${s.cookiesFromBrowser} and log in, then press Test here. It turns green once the login can be read.`];
    } else {
      state = 'missing';
      const fix = /ItemNotFound|Item does not exist|keyring/i.test(c.error)
        ? 'the desktop’s keyring has an entry it cannot open. Restart the computer (restarting the apps is not enough), then press Test.'
        : /secretstorage/i.test(c.error)
          ? 'gallery-dl lacks the secretstorage package it needs on Linux to read the keyring. Press Update on the gallery-dl row above, which adds it, then press Test.'
          : /not installed/i.test(c.error)
            ? 'install gallery-dl with the button on its row above, then press Test.'
            : `check that ${s.cookiesFromBrowser} is the browser you use X in, then press Test.`;
      lines = [`${s.cookiesFromBrowser}’s cookies could not be read: ${c.error}.`, `Without them: ${FAILS}`, `To fix: ${fix}`];
    }
    const detail = createFragment((f) => lines.forEach((l, i) => f.createDiv({ text: l, attr: i ? { style: 'margin-top:4px;' } : {} })));
    const cookieRow = this.row('Cookies', state, detail, null);
    if ((r.browsers || []).length && !s.cookiesFile) {
      cookieRow.addDropdown((d) => {
        d.addOption('', 'None');
        for (const b of r.browsers) d.addOption(b.name, b.name);
        d.setValue(s.cookiesFromBrowser || '');
        d.onChange(async (v) => {
          s.cookiesFromBrowser = v;
          await this.plugin.saveSettings();
          this.report.cookies = v ? await this.plugin.testCookies(v) : null;
          this.render();
        });
      });
      if (s.cookiesFromBrowser) {
        cookieRow.addButton((b) => b.setButtonText('Test').onClick(async () => {
          b.setDisabled(true).setButtonText('Testing…');
          this.report.cookies = await this.plugin.testCookies(s.cookiesFromBrowser);
          this.render();
        }));
      }
    }

    new Setting(contentEl)
      .addButton((b) => b.setButtonText('Check Again').onClick(() => this.refresh()))
      .addButton((b) => b.setButtonText('Close').setCta().onClick(() => this.close()));
  }

  onClose() { this.contentEl.empty(); }
}

/* ---------------- settings tab ---------------- */

class ArchXSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    // Its fields hold paths, commands, patterns and lists, not prose, so no
    // spell-check underlines; set as each one gets focus, which is when they appear.
    this.containerEl.addEventListener('focusin', (e) => {
      if (e.target.matches('input[type="text"], input:not([type]), textarea')) e.target.spellcheck = false;
    });
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();

    // Setup has its own row, as in After Clipping and YT Playlists (0.11.5); it
    // shared one labelled "gallery-dl" with Update and Sync Everything.
    new Setting(containerEl)
      .setName('Set Up External Tools')
      .setDesc('Finds gallery-dl, Python, ffmpeg and your browsers, fills in the settings, installs gallery-dl if it is missing, and checks that the browser’s X login can be read.')
      .addButton((b) => b.setButtonText('Open Setup').onClick(() => this.plugin.setup()));

    new Setting(containerEl)
      .setName('Sync Everything')
      .setDesc('The bulk list and every row below, one profile at a time.')
      .addButton((b) => b.setButtonText('Sync Everything').setCta()
        .onClick(() => this.plugin.enqueue(() => this.plugin.syncAll())));

    new Setting(containerEl)
      .setName('Reset Templates and Folders')
      .setDesc('Puts the note templates, folder layout, tags and link style back to this version\'s defaults. Profiles, cookies and limits are untouched.')
      .addButton((b) => b.setWarning().setButtonText('Reset').onClick(async () => {
        this.plugin.resetTemplateSettings();
        await save();
        new Notice('Templates and folders reset to defaults.', 6000);
        this.display();
      }));

    // ---- the long tail: text, not rows ----
    const bulk = this.plugin.bulkProfiles();
    new Setting(containerEl).setName(`Bulk List (${bulk.length})`).setHeading();
    // One card with the count, the explanation and the buttons; the list itself is
    // edited in a popup (ListModal), as in YT Playlists' channel list (2026-09-27). It
    // was a loose paragraph, a bare <details> and a sixteen-line box.
    const countBulk = (text) => {
      const n = this.plugin.bulkProfiles(text).length;
      return n ? `${n} profile${n === 1 ? '' : 's'}` : 'No profiles yet';
    };
    new Setting(containerEl)
      .setName('Profiles in the Bulk List')
      .setDesc(`${countBulk(s.bulkList)}. One per line: @handle or a full x.com URL; a line starting with # is a note to yourself. Every profile here shares the options below.`)
      .addButton((b) => b.setButtonText('Manage\u2026').onClick(() =>
        new ListModal(this.app, {
          title: 'Bulk List',
          hint: 'One per line: @handle or a full x.com URL. A line starting with # is a note to yourself.',
          value: s.bulkList || '',
          placeholder: '@karpathy\nhttps://x.com/AnthropicAI',
          count: countBulk,
          onSave: async (v) => { s.bulkList = v; await save(); this.display(); },
        }).open()))
      .addButton((b) => b.setButtonText(`Sync ${bulk.length}`).setCta().setDisabled(!bulk.length)
        .onClick(() => this.plugin.enqueue(() => this.plugin.syncList(this.plugin.bulkProfiles(), 'the bulk list'))))
      .addButton((b) => b.setButtonText('Profile Notes Only').setDisabled(!bulk.length)
        .setTooltip('Fetch each profile note and its images, and write no posts')
        .onClick(() => this.plugin.enqueue(() => this.plugin.syncList(this.plugin.bulkProfiles(), 'the bulk list', { profileOnly: true }))));

    new Setting(containerEl).setName('Timeline for the Bulk List')
      .addDropdown((d) => d.addOptions({ '': 'Use the Default Below', posts: 'Posts', tweets: 'Tweets Tab', replies: 'With Replies (Cookies)', media: 'Media Only (Cookies)', likes: 'Likes (Cookies)' })
        .setValue(s.bulkTimeline).onChange(async (v) => { s.bulkTimeline = v; await save(); }));
    new Setting(containerEl).setName('Posts per Profile for the Bulk List')
      .setDesc('Blank uses the default below.')
      .addText((t) => t.setPlaceholder('default').setValue(String(s.bulkMaxPerProfile ?? ''))
        .onChange(async (v) => { s.bulkMaxPerProfile = v.trim(); await save(); }));
    new Setting(containerEl).setName('Tags for the Bulk List')
      .setDesc('Blank uses the default post tags.')
      .addText((t) => t.setPlaceholder('default').setValue(s.bulkTags)
        .onChange(async (v) => { s.bulkTags = v.trim(); await save(); }));

    // ---- the few that need their own settings ----
    new Setting(containerEl).setName(`Individual Profiles (${s.profiles.length})`).setHeading();
    // What the rows are for, beside the buttons that sync them, as on the bulk card;
    // the add box has a card of its own, since sharing one squeezed the explanation
    // into a column six lines tall (2026-09-27).
    new Setting(containerEl)
      .setName('Profiles in Rows')
      .setDesc('For accounts you want to sync on their own, or that need different options from the bulk list. A handle in both lists is synced once, using the row.')
      .addButton((b) => b.setButtonText('Sync Rows').setCta().setDisabled(!s.profiles.length)
        .onClick(() => this.plugin.enqueue(() => this.plugin.syncList(this.plugin.individualProfiles(), 'individual profiles'))))
      .addButton((b) => b.setButtonText('Profile Notes Only').setDisabled(!s.profiles.length)
        .onClick(() => this.plugin.enqueue(() => this.plugin.syncList(this.plugin.individualProfiles(), 'individual profiles', { profileOnly: true }))));

    let pending = '';
    new Setting(containerEl)
      .setName('Add a Profile')
      .addText((t) => t.setPlaceholder('@handle or x.com URL').onChange((v) => { pending = v.trim(); }))
      .addButton((b) => b.setButtonText('Add').onClick(async () => {
        const { handleFromUrl } = this.plugin.lib();
        const handle = (handleFromUrl(pending) || pending.replace(/^@/, '')).split(/[/?]/)[0];
        if (!handle) return new Notice('That is not a usable handle.', 5000);
        if (s.profiles.some((p) => p.handle.toLowerCase() === handle.toLowerCase())) {
          return new Notice(`@${handle} is already a row.`, 5000);
        }
        s.profiles.push({ handle, timeline: '', note: `@${handle}`, tags: '', enabled: true });
        await save();
        this.display();
      }));

    const list = containerEl.createDiv();
    list.style.maxHeight = '320px';
    list.style.overflowY = 'auto';
    s.profiles.forEach((p, i) => {
      new Setting(list)
        .setName(`@${p.handle}`)
        .addToggle((t) => t.setTooltip('Include when syncing rows').setValue(p.enabled !== false)
          .onChange(async (v) => { p.enabled = v; await save(); }))
        .addDropdown((d) => d.addOptions({ '': 'Default Timeline', posts: 'Posts', tweets: 'Tweets Tab', replies: 'With Replies (Cookies)', media: 'Media Only (Cookies)', likes: 'Likes (Cookies)' })
          .setValue(p.timeline || '').onChange(async (v) => { p.timeline = v; await save(); }))
        .addButton((b) => b.setIcon('user').setTooltip('Profile note only, no posts')
          .onClick(() => this.plugin.enqueue(async () => {
            await this.plugin.syncProfile(p, { profileOnly: true });
            new Notice(`Profile note for @${p.handle} written.`, 6000);
          })))
        .addButton((b) => b.setIcon('refresh-cw').setTooltip('Sync this profile')
          .onClick(() => this.plugin.enqueue(async () => {
            const n = await this.plugin.syncProfile(p);
            new Notice(`${n} new notes from @${p.handle}.`, 6000);
          })))
        .addButton((b) => b.setIcon('list-plus').setTooltip('Move to the bulk list')
          .onClick(async () => {
            const lines = String(s.bulkList || '').split('\n').filter((l) => l.trim());
            lines.push(p.handle);
            s.bulkList = lines.join('\n');
            s.profiles.splice(i, 1);
            await save();
            this.display();
          }))
        .addButton((b) => b.setIcon('trash').setTooltip('Remove')
          .onClick(async () => { s.profiles.splice(i, 1); await save(); this.display(); }));
    });

    new Setting(containerEl).setName('What to Fetch').setHeading();

    new Setting(containerEl).setName('Default Timeline')
      .addDropdown((d) => d.addOptions({ posts: 'Posts', tweets: 'Tweets Tab', replies: 'With Replies (Cookies)', media: 'Media Only (Cookies)', likes: 'Likes (Cookies)' })
        .setValue(s.timeline).onChange(async (v) => { s.timeline = v; await save(); }));

    new Setting(containerEl).setName('Most Recent Posts per Profile')
      .setDesc('0 fetches the whole timeline. Start small: X rate-limits hard and 150 profiles is a lot of requests.')
      .addText((t) => t.setValue(String(s.maxPerProfile)).onChange(async (v) => { s.maxPerProfile = Number(v) || 0; await save(); }));

    new Setting(containerEl).setName('Seconds between Requests')
      .setDesc('The single most effective setting against rate limiting.')
      .addText((t) => t.setValue(String(s.sleepRequest)).onChange(async (v) => { s.sleepRequest = Number(v) || 0; await save(); }));

    new Setting(containerEl).setName('Include Reposts')
      .addToggle((t) => t.setValue(s.retweets).onChange(async (v) => { s.retweets = v; await save(); }));
    new Setting(containerEl).setName('Include Replies')
      .addToggle((t) => t.setValue(s.replies).onChange(async (v) => { s.replies = v; await save(); }));
    new Setting(containerEl).setName('Include Quoted Posts')
      .addToggle((t) => t.setValue(s.quoted).onChange(async (v) => { s.quoted = v; await save(); }));
    new Setting(containerEl).setName('Include Text-Only Posts')
      .setDesc('Off makes this a media archiver only — gallery-dl skips posts with no image or video.')
      .addToggle((t) => t.setValue(s.textTweets).onChange(async (v) => { s.textTweets = v; await save(); }));

    new Setting(containerEl).setName('Notes').setHeading();

    const TOKENS = 'Tokens: {{handle}} {{author}} {{date}} {{year}} {{month}}';

    new Setting(containerEl).setName('Archive Root')
      .setDesc('The folder the "archive root" modes below are relative to.')
      .addText((t) => t.setValue(s.archiveRoot).onChange(async (v) => { s.archiveRoot = v.trim(); await save(); }));

    new Setting(containerEl).setName('Where Profile Notes Go')
      .addDropdown((d) => d.addOptions({
        specified: 'One Folder',
        perProfile: 'A Folder per Profile',
        root: 'The Archive Root',
        subfolder: 'Subfolder under the Archive Root',
        vault: 'Vault Root',
      }).setValue(s.profileLocationMode).onChange(async (v) => { s.profileLocationMode = v; await save(); this.display(); }));

    if (s.profileLocationMode === 'subfolder') {
      new Setting(containerEl).setName('Profile Subfolder').setDesc(TOKENS)
        .addText((t) => t.setValue(s.profileSubfolder).onChange(async (v) => { s.profileSubfolder = v.trim(); await save(); }));
    }
    if (s.profileLocationMode === 'specified' || s.profileLocationMode === 'perProfile') {
      new Setting(containerEl).setName('Profile Folder').setDesc(TOKENS)
        .addText((t) => t.setValue(s.profileFolder).onChange(async (v) => { s.profileFolder = v.trim(); await save(); }));
    }

    new Setting(containerEl).setName('Where Post Notes Go')
      .setDesc('"Same Folder" and "Subfolder" are relative to the profile note.')
      .addDropdown((d) => d.addOptions({
        specified: 'One Folder',
        perProfile: 'A Folder per Profile',
        same: 'Same Folder as the Profile Note',
        subfolder: 'Subfolder beside the Profile Note',
        vault: 'Vault Root',
      }).setValue(s.postLocationMode).onChange(async (v) => { s.postLocationMode = v; await save(); this.display(); }));

    if (s.postLocationMode === 'subfolder') {
      new Setting(containerEl).setName('Post Subfolder').setDesc(TOKENS)
        .addText((t) => t.setValue(s.postSubfolder).onChange(async (v) => { s.postSubfolder = v.trim(); await save(); }));
    }
    if (s.postLocationMode === 'specified' || s.postLocationMode === 'perProfile') {
      new Setting(containerEl).setName('Post Folder').setDesc(TOKENS)
        .addText((t) => t.setValue(s.postFolder).onChange(async (v) => { s.postFolder = v.trim(); await save(); }));
    }

    // Shows exactly where the next sync will put things. Two folder settings
    // with five modes each is easy to get wrong silently.
    const sample = { handle: 'example' };
    const pf = this.plugin.profileFolderFor(sample);
    new Setting(containerEl).setName('For @example, that is')
      .setDesc(`Profile note: ${pf || '(vault root)'}/@example.md\nPost notes: ${this.plugin.postFolderFor(sample, pf) || '(vault root)'}/`);
    new Setting(containerEl).setName('Post Note Name')
      .setDesc('Tokens: {{author}} {{authorName}} {{date}} {{id}} {{excerpt}}')
      .addText((t) => t.setValue(s.postNoteNameTemplate).onChange(async (v) => { s.postNoteNameTemplate = v; await save(); }));
    new Setting(containerEl).setName('Write url as a Markdown Link')
      .setDesc('On gives [Link](https://x.com/…), matching the hand-made notes. Off gives a bare URL. A sync overwrites whichever form a note already had, so decide before syncing notes you made by hand.')
      .addToggle((t) => t.setValue(s.urlAsLink).onChange(async (v) => { s.urlAsLink = v; await save(); }));

    new Setting(containerEl).setName('x-author Links to the Profile Note')
      .setDesc('On writes [[@handle]] on post notes, so one property both names the author and gets you there. Off writes a plain @handle.')
      .addToggle((t) => t.setValue(s.authorAsLink).onChange(async (v) => { s.authorAsLink = v; await save(); }));

    new Setting(containerEl).setName('Post Tags')
      .addText((t) => t.setValue(s.tags.join(', ')).onChange(async (v) => { s.tags = splitList(v); await save(); }));
    new Setting(containerEl).setName('Profile Tags')
      .addText((t) => t.setValue(s.profileTags.join(', ')).onChange(async (v) => { s.profileTags = splitList(v); await save(); }));

    new Setting(containerEl).setName('Profile Picture and Header').setHeading();

    new Setting(containerEl).setName('Download the Icon and Banner')
      .setDesc('Saved beside the profile note and written into its icon and banner properties. The URLs come free with the metadata, so this costs two downloads per profile and no extra API calls.')
      .addToggle((t) => t.setValue(s.downloadProfileImages).onChange(async (v) => { s.downloadProfileImages = v; await save(); this.display(); }));

    if (s.downloadProfileImages) {
      new Setting(containerEl).setName('Where the Images Go')
        .addDropdown((d) => d.addOptions({
          subfolder: 'Subfolder beside the Profile Note',
          same: 'Same Folder as the Profile Note',
          specified: 'One Folder',
          perProfile: 'A Folder per Profile',
          vault: 'Vault Root',
        }).setValue(s.profileImageLocationMode).onChange(async (v) => { s.profileImageLocationMode = v; await save(); this.display(); }));

      if (s.profileImageLocationMode === 'subfolder') {
        new Setting(containerEl).setName('Image Subfolder').setDesc(TOKENS)
          .addText((t) => t.setValue(s.profileImageSubfolder).onChange(async (v) => { s.profileImageSubfolder = v.trim(); await save(); }));
      }
      if (s.profileImageLocationMode === 'specified' || s.profileImageLocationMode === 'perProfile') {
        new Setting(containerEl).setName('Image Folder').setDesc(TOKENS)
          .addText((t) => t.setValue(s.profileImageFolder).onChange(async (v) => { s.profileImageFolder = v.trim(); await save(); }));
      }

      new Setting(containerEl).setName('Icon File Name').setDesc('Tokens: {{author}} {{handle}}')
        .addText((t) => t.setValue(s.iconNameTemplate).onChange(async (v) => { s.iconNameTemplate = v; await save(); }));
      new Setting(containerEl).setName('Banner File Name').setDesc('Tokens: {{author}} {{handle}}')
        .addText((t) => t.setValue(s.bannerNameTemplate).onChange(async (v) => { s.bannerNameTemplate = v; await save(); }));

      new Setting(containerEl).setName('Convert to WebP')
        .setDesc('X serves JPEG. WebP is roughly half the size. An image that would come out larger keeps its original format.')
        .addDropdown((d) => d.addOptions({ webp: 'Convert to WebP', keep: 'Keep What X Serves' })
          .setValue(s.profileImageFormat).onChange(async (v) => { s.profileImageFormat = v; await save(); }));

      new Setting(containerEl).setName('Re-download on Every Sync')
        .setDesc('Off means an image already on disk is left alone, which is what makes a re-run of every profile cheap. Turn it on once to pick up changed avatars, then turn it off.')
        .addToggle((t) => t.setValue(s.refreshProfileImages).onChange(async (v) => { s.refreshProfileImages = v; await save(); }));

      const sampleP = { handle: 'example' };
      const pf2 = this.plugin.profileFolderFor(sampleP);
      new Setting(containerEl).setName('For @example, that is')
        .setDesc(`${this.plugin.imageFolderFor(sampleP, pf2) || '(vault root)'}/${this.plugin.imageStem(s.iconNameTemplate, sampleP)}.webp`);
    }

    new Setting(containerEl).setName('Access').setHeading();

    const browsers = this.plugin.detectBrowsers();
    new Setting(containerEl).setName('Cookies from Browser')
      .setDesc('Posts works without cookies via a guest token. Replies, media and likes do not. Cookies are read at run time and never stored here.')
      .addDropdown((d) => {
        d.addOption('', 'None');
        for (const b of browsers) d.addOption(b.name, b.name);
        d.setValue(s.cookiesFromBrowser).onChange(async (v) => { s.cookiesFromBrowser = v; await save(); });
      });
    new Setting(containerEl).setName('Or a cookies.txt File')
      .addText((t) => t.setValue(s.cookiesFile).onChange(async (v) => { s.cookiesFile = v.trim(); await save(); }));
    new Setting(containerEl).setName('Remember What Has Been Fetched')
      .setDesc('Keeps a download archive so re-running a profile is cheap.')
      .addToggle((t) => t.setValue(s.useDownloadArchive).onChange(async (v) => { s.useDownloadArchive = v; await save(); }));
    new Setting(containerEl).setName('Extra gallery-dl Arguments')
      .addText((t) => t.setValue(s.extraArgs).onChange(async (v) => { s.extraArgs = v; await save(); }));
  }
}

module.exports = ArchXArchivePlugin;
