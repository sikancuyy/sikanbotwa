const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('./config');
const { resolveBinary, deleteFileSafe, killProcessTree, log } = require('./utils');
const { processVideoForWhatsApp } = require('./helpers/videoOptimizer');
const {
  classifyError,
  logServiceError,
  logServiceEvent,
  ERROR_CATEGORIES
} = require('./helpers/errorHandler');

/**
 * Worker Pool & Concurrency Manager untuk unduhan simultan multi-user.
 * Mengizinkan setiap user mendownload secara bersamaan tanpa saling menunggu dalam satu antrean sempit,
 * sekaligus melindungi kapasitas CPU & RAM VPS agar tidak mengalami OOM (Out of Memory).
 */
class ConcurrentDownloadManager {
  constructor(maxConcurrency = 8, perUserLimit = 2) {
    const cpus = os.cpus()?.length || 2;
    this.maxConcurrency = maxConcurrency || Math.max(6, cpus * 2);
    this.perUserLimit = perUserLimit || 2;
    this.activeWorkers = new Map(); // workerId -> { id, userId, startTime, proc }
    this.userActiveCount = new Map(); // userId -> activeCount
    this.waitQueue = []; // Fallback queue jika VPS mencapai kapasitas maksimal beban tinggi
  }

  get running() {
    return this.activeWorkers.size;
  }

  get activeCount() {
    return this.activeWorkers.size;
  }

  get queueCount() {
    return this.waitQueue.length;
  }

  /**
   * Menjalankan fungsi unduhan dengan pengelolaan worker independen.
   * @param {Function} taskFn Fungsi eksekusi unduhan
   * @param {string} userId ID user pemilik request (opsional)
   * @returns {Promise<any>}
   */
  enqueue(taskFn, userId = 'guest') {
    return new Promise((resolve, reject) => {
      const userRunning = this.userActiveCount.get(userId) || 0;

      if (this.activeWorkers.size < this.maxConcurrency && userRunning < this.perUserLimit) {
        this.runTask(taskFn, userId, resolve, reject);
      } else {
        this.waitQueue.push({ taskFn, userId, resolve, reject, queuedAt: Date.now() });
        if (this.activeWorkers.size < this.maxConcurrency) {
          this.processNext();
        }
      }
    });
  }

  runTask(taskFn, userId, resolve, reject) {
    const workerId = `w_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    this.activeWorkers.set(workerId, { userId, startTime: Date.now() });
    this.userActiveCount.set(userId, (this.userActiveCount.get(userId) || 0) + 1);

    taskFn()
      .then((res) => {
        resolve(res);
      })
      .catch((err) => {
        reject(err);
      })
      .finally(() => {
        this.activeWorkers.delete(workerId);
        const currentCount = this.userActiveCount.get(userId) || 1;
        if (currentCount <= 1) {
          this.userActiveCount.delete(userId);
        } else {
          this.userActiveCount.set(userId, currentCount - 1);
        }
        this.processNext();
      });
  }

  processNext() {
    if (this.activeWorkers.size >= this.maxConcurrency || this.waitQueue.length === 0) {
      return;
    }

    let selectedIndex = this.waitQueue.findIndex(
      (item) => (this.userActiveCount.get(item.userId) || 0) < this.perUserLimit
    );

    if (selectedIndex === -1) {
      selectedIndex = 0;
    }

    const [item] = this.waitQueue.splice(selectedIndex, 1);
    if (item) {
      this.runTask(item.taskFn, item.userId, item.resolve, item.reject);
    }
  }
}

const downloadQueue = new ConcurrentDownloadManager(
  config.maxConcurrentDownloads || 8,
  config.perUserConcurrentLimit || 2
);

/**
 * Mengecek apakah yt-dlp binary dapat dijalankan di sistem.
 * @returns {Promise<boolean>}
 */
function checkYtDlpAvailable() {
  return new Promise((resolve) => {
    const ytdlpBin = resolveBinary(config.ytdlp);
    const proc = spawn(ytdlpBin, ['--version'], { windowsHide: true });

    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });
}

/**
 * Mengambil metadata singkat video (judul, estimasi durasi) tanpa mendownload.
 * @param {string} url URL video
 * @returns {Promise<{ title: string, duration: number|null }>}
 */
function getVideoMetadata(url) {
  return new Promise((resolve) => {
    const ytdlpBin = resolveBinary(config.ytdlp);
    const args = [
      '--dump-single-json',
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificates',
      '--socket-timeout', '10',
      url
    ];

    const cookiesFile = path.join(__dirname, 'cookies.txt');
    if (fs.existsSync(cookiesFile)) {
      args.splice(args.length - 1, 0, '--cookies', cookiesFile);
    }

    let stdout = '';
    const proc = spawn(ytdlpBin, args, { windowsHide: true });

    const timer = setTimeout(() => {
      try { killProcessTree(proc); } catch (_) {}
      resolve({ title: 'Video WhatsApp', duration: null });
    }, 12000);

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.on('close', () => {
      clearTimeout(timer);
      try {
        const json = JSON.parse(stdout);
        resolve({
          title: json.title || 'Video WhatsApp',
          duration: json.duration || null
        });
      } catch {
        resolve({ title: 'Video WhatsApp', duration: null });
      }
    });
    proc.on('error', () => {
      clearTimeout(timer);
      resolve({ title: 'Video WhatsApp', duration: null });
    });
  });
}

/**
 * Pembersihan file residu (.part, .ytdl, .temp) jika download gagal atau dibatalkan.
 * @param {string} basePattern Prefix nama file yang diunduh
 */
function cleanStrayTempFiles(basePattern) {
  try {
    if (!fs.existsSync(config.downloadDir)) return;
    const files = fs.readdirSync(config.downloadDir);
    for (const f of files) {
      if (f.startsWith(basePattern) && (f.endsWith('.part') || f.endsWith('.ytdl') || f.endsWith('.temp') || f.endsWith('.webm') || f.endsWith('.m4a'))) {
        deleteFileSafe(path.join(config.downloadDir, f));
      }
    }
  } catch (_) {}
}

/**
 * Helper untuk menyelesaikan target unduhan (URL langsung vs query pencarian)
 * @param {string} targetUrlOrQuery
 * @returns {Promise<{ target: string, titleHint: string }>}
 */
async function resolveMediaTarget(targetUrlOrQuery) {
  const trimmed = String(targetUrlOrQuery || '').trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return { target: trimmed, titleHint: trimmed };
  }

  // Jika berupa query, cari tautan YouTube langsung melalui scraper pencarian
  try {
    const scraper = require('./lib/scraper');
    if (typeof scraper.searchYouTube === 'function') {
      const results = await scraper.searchYouTube(trimmed, 1);
      if (results && results.length > 0 && results[0].url) {
        return {
          target: results[0].url,
          titleHint: results[0].title || trimmed
        };
      }
    }
  } catch (_) {}

  // Fallback jika pencarian internal gagal: gunakan ytsearch bawaan yt-dlp
  return {
    target: `ytsearch1:${trimmed}`,
    titleHint: trimmed
  };
}

/**
 * Fungsi internal download file video menggunakan yt-dlp secara teroptimasi.
 * @param {string} url URL video atau query judul
 * @param {string} id ID unik transaksi
 * @returns {Promise<{ filePath: string, title: string, fileSize: number }>}
 */
async function executeDownload(url, id) {
  const { target, titleHint } = await resolveMediaTarget(url);
  const isYouTube = /youtu\.?be/i.test(target) || target.startsWith('ytsearch');
  const tag = isYouTube ? 'YT' : 'DOWNLOAD';

  logServiceEvent(tag, `Start download: ${titleHint.slice(0, 60)}`);

  return new Promise((resolve, reject) => {
    const ytdlpBin = resolveBinary(config.ytdlp);
    const ffmpegBin = resolveBinary(config.ffmpeg);

    const uniquePrefix = `${id}_${Date.now()}`;
    const outputTemplate = path.join(config.downloadDir, `${uniquePrefix}.%(ext)s`);

    const args = [
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificates',
      '--max-filesize', `${config.maxFileSizeMB}M`,
      '--concurrent-fragments', '4',
      // Prioritaskan format MP4 (H.264) + M4A (AAC) agar remux cepat & kompatibel WhatsApp
      '-f', 'b[ext=mp4][vcodec^=avc1][acodec^=mp4a]/b[ext=mp4]/bv*[height<=720][vcodec^=avc1][ext=mp4]+ba[acodec^=mp4a][ext=m4a]/bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/bv*[height<=720]+ba/b[height<=720]/best',
      '--merge-output-format', 'mp4',
      '--socket-timeout', '15',
      '--retries', '2',
      '--fragment-retries', '2',
      '--buffer-size', '32K',
      '--no-mtime',
      '--output', outputTemplate,
      '--print', 'after_move:title',
      target
    ];

    if (ffmpegBin && fs.existsSync(ffmpegBin)) {
      const ffmpegDir = fs.statSync(ffmpegBin).isDirectory() ? ffmpegBin : path.dirname(ffmpegBin);
      args.splice(args.length - 1, 0, '--ffmpeg-location', ffmpegDir);
    }

    const cookiesFile = path.join(__dirname, 'cookies.txt');
    if (fs.existsSync(cookiesFile)) {
      args.splice(args.length - 1, 0, '--cookies', cookiesFile);
    }

    let stdout = '';
    let stderr = '';
    const proc = spawn(ytdlpBin, args, { windowsHide: true });

    let isTimedOut = false;
    const timeout = setTimeout(() => {
      isTimedOut = true;
      try { killProcessTree(proc); } catch (_) {}
      cleanStrayTempFiles(uniquePrefix);
      const timeoutErr = new Error('TIMEOUT');
      timeoutErr.category = ERROR_CATEGORIES.TIMEOUT;
      logServiceError(tag, timeoutErr, id);
      reject(timeoutErr);
    }, config.downloadTimeoutMs || 120000);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      cleanStrayTempFiles(uniquePrefix);
      const notFoundErr = new Error(`YTDLP_NOT_FOUND: ${err.message}`);
      notFoundErr.category = ERROR_CATEGORIES.DOWNLOAD_ERROR;
      logServiceError(tag, notFoundErr, id);
      reject(notFoundErr);
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (isTimedOut) return;

      if (code !== 0) {
        cleanStrayTempFiles(uniquePrefix);
        const classified = classifyError({ message: stderr, stderr }, { platform: isYouTube ? 'youtube' : 'video' });
        const err = new Error(classified.detail || `Download process exited with code ${code}`);
        err.category = classified.category;
        logServiceError(tag, err, `${id}: code ${code}`);
        return reject(err);
      }

      try {
        const files = fs.readdirSync(config.downloadDir);
        const matched = files.find((f) => (f.startsWith(uniquePrefix + '.') || f.startsWith(id + '.')) && !f.endsWith('.part') && !f.endsWith('.ytdl') && f !== '.gitkeep');

        if (!matched) {
          cleanStrayTempFiles(uniquePrefix);
          const fnfErr = new Error('FILE_NOT_FOUND');
          fnfErr.category = ERROR_CATEGORIES.FILE_ERROR;
          logServiceError(tag, fnfErr, id);
          return reject(fnfErr);
        }

        const filePath = path.join(config.downloadDir, matched);
        const stats = fs.statSync(filePath);

        if (stats.size === 0) {
          deleteFileSafe(filePath);
          cleanStrayTempFiles(uniquePrefix);
          const emptyErr = new Error('File hasil unduhan kosong (0 bytes).');
          emptyErr.category = ERROR_CATEGORIES.FILE_ERROR;
          logServiceError(tag, emptyErr, id);
          return reject(emptyErr);
        }

        if (stats.size > config.maxFileSizeMB * 1024 * 1024) {
          deleteFileSafe(filePath);
          cleanStrayTempFiles(uniquePrefix);
          const largeErr = new Error('FILE_TOO_LARGE');
          largeErr.category = ERROR_CATEGORIES.FILE_ERROR;
          logServiceError(tag, largeErr, id);
          return reject(largeErr);
        }

        const title = stdout.trim().split('\n').pop() || titleHint || 'Video Download';

        logServiceEvent(tag, `Download completed: ${matched} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
        logServiceEvent(tag, 'FFmpeg completed');

        resolve({
          filePath,
          title,
          fileSize: stats.size
        });
      } catch (err) {
        cleanStrayTempFiles(uniquePrefix);
        logServiceError(tag, err, id);
        reject(err);
      }
    });
  });
}

/**
 * Download audio murni (MP3) dari URL atau query pencarian.
 * Format MP3 preset VBR 5 menjamin kompatibilitas 100% pada pemutar WhatsApp Android, iOS, dan Web.
 * @param {string} url URL media atau query judul
 * @param {string} id ID transaksi unik
 * @returns {Promise<{ filePath: string, title: string, fileSize: number }>}
 */
async function executeDownloadAudio(url, id) {
  const { target, titleHint } = await resolveMediaTarget(url);
  const isYouTube = /youtu\.?be/i.test(target) || target.startsWith('ytsearch');
  const tag = isYouTube ? 'YT' : 'DOWNLOAD';

  logServiceEvent(tag, `Start download: ${titleHint.slice(0, 60)}`);
  logServiceEvent(tag, 'Extracting audio');

  return new Promise((resolve, reject) => {
    const ytdlpBin = resolveBinary(config.ytdlp);
    const ffmpegBin = resolveBinary(config.ffmpeg);

    const uniquePrefix = `${id}_${Date.now()}`;
    const outputTemplate = path.join(config.downloadDir, `${uniquePrefix}.%(ext)s`);

    const args = [
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificates',
      '--max-filesize', `${config.maxFileSizeMB}M`,
      '--concurrent-fragments', '4',
      '-f', 'ba/b',
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '5', // Preset VBR cepat, hemat beban CPU
      '--socket-timeout', '15',
      '--retries', '2',
      '--fragment-retries', '2',
      '--buffer-size', '32K',
      '--no-mtime',
      '--output', outputTemplate,
      '--print', 'after_move:title',
      target
    ];

    if (ffmpegBin && fs.existsSync(ffmpegBin)) {
      const ffmpegDir = fs.statSync(ffmpegBin).isDirectory() ? ffmpegBin : path.dirname(ffmpegBin);
      args.splice(args.length - 1, 0, '--ffmpeg-location', ffmpegDir);
    }

    const cookiesFile = path.join(__dirname, 'cookies.txt');
    if (fs.existsSync(cookiesFile)) {
      args.splice(args.length - 1, 0, '--cookies', cookiesFile);
    }

    let stdout = '';
    let stderr = '';
    const proc = spawn(ytdlpBin, args, { windowsHide: true });

    let isTimedOut = false;
    const timeout = setTimeout(() => {
      isTimedOut = true;
      try { killProcessTree(proc); } catch (_) {}
      cleanStrayTempFiles(uniquePrefix);
      const timeoutErr = new Error('TIMEOUT');
      timeoutErr.category = ERROR_CATEGORIES.TIMEOUT;
      logServiceError(tag, timeoutErr, id);
      reject(timeoutErr);
    }, config.downloadTimeoutMs || 120000);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      cleanStrayTempFiles(uniquePrefix);
      const notFoundErr = new Error(`YTDLP_NOT_FOUND: ${err.message}`);
      notFoundErr.category = ERROR_CATEGORIES.DOWNLOAD_ERROR;
      logServiceError(tag, notFoundErr, id);
      reject(notFoundErr);
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (isTimedOut) return;

      if (code !== 0) {
        cleanStrayTempFiles(uniquePrefix);
        const classified = classifyError({ message: stderr, stderr }, { platform: isYouTube ? 'youtube' : 'audio' });
        const err = new Error(classified.detail || `Audio extraction exited with code ${code}`);
        err.category = classified.category;
        logServiceError(tag, err, `${id}: code ${code}`);
        return reject(err);
      }

      try {
        const files = fs.readdirSync(config.downloadDir);
        const matched = files.find((f) => (f.startsWith(uniquePrefix + '.') || f.startsWith(id + '.')) && !f.endsWith('.part') && !f.endsWith('.ytdl') && f !== '.gitkeep');

        if (!matched) {
          cleanStrayTempFiles(uniquePrefix);
          const fnfErr = new Error('FILE_NOT_FOUND');
          fnfErr.category = ERROR_CATEGORIES.FILE_ERROR;
          logServiceError(tag, fnfErr, id);
          return reject(fnfErr);
        }

        const filePath = path.join(config.downloadDir, matched);
        const stats = fs.statSync(filePath);

        if (stats.size === 0) {
          deleteFileSafe(filePath);
          cleanStrayTempFiles(uniquePrefix);
          const emptyErr = new Error('File hasil ekstraksi audio kosong (0 bytes).');
          emptyErr.category = ERROR_CATEGORIES.FILE_ERROR;
          logServiceError(tag, emptyErr, id);
          return reject(emptyErr);
        }

        if (stats.size > config.maxFileSizeMB * 1024 * 1024) {
          deleteFileSafe(filePath);
          cleanStrayTempFiles(uniquePrefix);
          const largeErr = new Error('FILE_TOO_LARGE');
          largeErr.category = ERROR_CATEGORIES.FILE_ERROR;
          logServiceError(tag, largeErr, id);
          return reject(largeErr);
        }

        const title = stdout.trim().split('\n').pop() || titleHint || 'Audio Download';

        logServiceEvent(tag, 'FFmpeg completed');
        logServiceEvent(tag, `Download completed: ${matched} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

        resolve({
          filePath,
          title,
          fileSize: stats.size
        });
      } catch (err) {
        cleanStrayTempFiles(uniquePrefix);
        logServiceError(tag, err, id);
        reject(err);
      }
    });
  });
}

const { globalJobQueue } = require('./helpers/jobQueue');

/**
 * Menjalankan proses download video secara terkelola melalui JobQueue
 * dengan proteksi timeout, deduplikasi, dan retry terbatas untuk transient error.
 * @param {string} url URL video atau query judul
 * @param {string} id ID transaksi unik
 * @param {string} [userId='guest'] ID user pemohon
 * @returns {Promise<{ filePath: string, title: string, fileSize: number }>}
 */
function downloadVideo(url, id, userId = 'guest') {
  return globalJobQueue.enqueue(() => executeDownload(url, id), {
    userId,
    type: 'download_video',
    jobKey: `dl_vid_${url}`,
    timeoutMs: config.downloadTimeoutMs || 120000,
    maxRetries: 1
  });
}

/**
 * Menjalankan proses download audio murni secara terkelola melalui JobQueue.
 * @param {string} url URL media atau query judul
 * @param {string} id ID transaksi unik
 * @param {string} [userId='guest'] ID user pemohon
 * @returns {Promise<{ filePath: string, title: string, fileSize: number }>}
 */
function downloadAudio(url, id, userId = 'guest') {
  return globalJobQueue.enqueue(() => executeDownloadAudio(url, id), {
    userId,
    type: 'download_audio',
    jobKey: `dl_aud_${url}`,
    timeoutMs: config.downloadTimeoutMs || 120000,
    maxRetries: 1
  });
}

/**
 * Alias fungsi download YouTube Audio untuk standarisasi modul
 */
const downloadYouTubeAudio = downloadAudio;

/**
 * Alias fungsi download YouTube Video untuk standarisasi modul
 */
const downloadYouTubeVideo = downloadVideo;

module.exports = {
  checkYtDlpAvailable,
  getVideoMetadata,
  downloadVideo,
  downloadAudio,
  downloadYouTubeAudio,
  downloadYouTubeVideo,
  executeDownload,
  executeDownloadAudio,
  downloadQueue,
  globalJobQueue,
  processVideoForWhatsApp
};
