const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('./config');
const { resolveBinary, deleteFileSafe, log } = require('./utils');
const { processVideoForWhatsApp } = require('./helpers/videoOptimizer');

/**
 * Worker Pool & Concurrency Manager untuk unduhan simultan multi-user.
 * Mengizinkan setiap user mendownload secara bersamaan tanpa saling menunggu dalam satu antrean sempit,
 * sekaligus melindungi kapasitas CPU & RAM VPS agar tidak mengalami OOM (Out of Memory).
 */
class ConcurrentDownloadManager {
  constructor(maxConcurrency = 8, perUserLimit = 2) {
    // Tentukan kapasitas maksimum berdasarkan konfigurasi atau kapasitas core VPS
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

      // Jika masih ada slot server dan user belum melebihi limit per-user, langsung jalankan seketika (instant worker)
      if (this.activeWorkers.size < this.maxConcurrency && userRunning < this.perUserLimit) {
        this.runTask(taskFn, userId, resolve, reject);
      } else {
        // Jika kapasitas VPS sedang penuh atau user sedang menjalankan download lain, simpan di buffer antrean
        this.waitQueue.push({ taskFn, userId, resolve, reject, queuedAt: Date.now() });
        // Jika ada kapasitas kosong, coba proses
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

    // Prioritaskan user yang belum memiliki unduhan aktif (fair-share scheduling)
    let selectedIndex = this.waitQueue.findIndex(
      (item) => (this.userActiveCount.get(item.userId) || 0) < this.perUserLimit
    );

    if (selectedIndex === -1) {
      // Jika semua item di antrean adalah user yang sama dan kapasitas server masih ada, ambil item pertama
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
      try { proc.kill('SIGKILL'); } catch (_) {}
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
      if (f.startsWith(basePattern) && (f.endsWith('.part') || f.endsWith('.ytdl') || f.endsWith('.temp'))) {
        deleteFileSafe(path.join(config.downloadDir, f));
      }
    }
  } catch (_) {}
}

/**
 * Fungsi internal download file video menggunakan child_process.spawn yt-dlp.
 * Dilengkapi multi-fragmenting (-N 4), preferensi H.264/AAC untuk fast remuxing tanpa re-encoding,
 * timeout adaptif, dan isolasi file unik per request.
 * @param {string} url URL video
 * @param {string} id ID unik transaksi
 * @returns {Promise<{ filePath: string, title: string, fileSize: number }>}
 */
function executeDownload(url, id) {
  return new Promise((resolve, reject) => {
    const ytdlpBin = resolveBinary(config.ytdlp);
    const ffmpegBin = resolveBinary(config.ffmpeg);

    // Template output unik per-request agar tidak saling tumpang tindih
    const uniquePrefix = `${id}_${Date.now()}`;
    const outputTemplate = path.join(config.downloadDir, `${uniquePrefix}.%(ext)s`);

    const args = [
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificates',
      '--max-filesize', `${config.maxFileSizeMB}M`,
      '--extractor-args', 'youtube:player_client=android,ios,web',
      // Multi-threaded fragment downloading: percepat download stream HLS/DASH hingga 3-5x lipat
      '--concurrent-fragments', '4',
      // Prioritaskan format MP4 (H.264) + M4A (AAC) atau progressive stream MP4 langsung agar FFmpeg tidak perlu merge berat
      '-f', 'b[ext=mp4][vcodec^=avc1][acodec^=mp4a]/b[ext=mp4]/bv*[height<=720][vcodec^=avc1][ext=mp4]+ba[acodec^=mp4a][ext=m4a]/bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/bv*[height<=720]+ba/b[height<=720]/best',
      '--merge-output-format', 'mp4',
      '--socket-timeout', '15',
      '--retries', '3',
      '--fragment-retries', '3',
      '--buffer-size', '32K',
      '--no-mtime',
      '--output', outputTemplate,
      '--print', 'after_move:title',
      url
    ];

    // Jika ffmpeg terdeteksi atau dikonfigurasi, sertakan direktori ffmpeg
    if (ffmpegBin && fs.existsSync(ffmpegBin)) {
      const ffmpegDir = fs.statSync(ffmpegBin).isDirectory() ? ffmpegBin : path.dirname(ffmpegBin);
      args.splice(args.length - 1, 0, '--ffmpeg-location', ffmpegDir);
    }

    // Jika cookies.txt tersedia, sertakan untuk autentikasi konten berprivat/login
    const cookiesFile = path.join(__dirname, 'cookies.txt');
    if (fs.existsSync(cookiesFile)) {
      args.splice(args.length - 1, 0, '--cookies', cookiesFile);
    }

    log('INFO', `[${id}] Memulai concurrent download: ${url}`);

    let stdout = '';
    let stderr = '';
    const proc = spawn(ytdlpBin, args, { windowsHide: true });

    let isTimedOut = false;
    const timeout = setTimeout(() => {
      isTimedOut = true;
      try { proc.kill('SIGKILL'); } catch (_) {}
      cleanStrayTempFiles(uniquePrefix);
      reject(new Error('TIMEOUT'));
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
      log('ERROR', `[${id}] Gagal menjalankan yt-dlp: ${err.message}`);
      reject(new Error('YTDLP_NOT_FOUND'));
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (isTimedOut) return;

      if (code !== 0) {
        cleanStrayTempFiles(uniquePrefix);
        log('WARN', `[${id}] yt-dlp exit code ${code}. Stderr: ${stderr.trim().slice(-200)}`);

        const lowerErr = stderr.toLowerCase();
        if (lowerErr.includes('file is larger than max-filesize') || lowerErr.includes('larger than max-filesize')) {
          return reject(new Error('FILE_TOO_LARGE'));
        }
        if (lowerErr.includes('unsupported url') || lowerErr.includes('is not a valid url')) {
          return reject(new Error('INVALID_URL'));
        }
        return reject(new Error('DOWNLOAD_FAILED'));
      }

      // Cari file hasil download
      try {
        const files = fs.readdirSync(config.downloadDir);
        // Cocokkan dengan uniquePrefix atau id transaksi
        const matched = files.find((f) => (f.startsWith(uniquePrefix + '.') || f.startsWith(id + '.')) && !f.endsWith('.part') && !f.endsWith('.ytdl') && f !== '.gitkeep');

        if (!matched) {
          cleanStrayTempFiles(uniquePrefix);
          return reject(new Error('FILE_NOT_FOUND'));
        }

        const filePath = path.join(config.downloadDir, matched);
        const stats = fs.statSync(filePath);

        // Validasi ukuran file terhadap batas maksimal
        if (stats.size > config.maxFileSizeMB * 1024 * 1024) {
          deleteFileSafe(filePath);
          cleanStrayTempFiles(uniquePrefix);
          return reject(new Error('FILE_TOO_LARGE'));
        }

        const title = stdout.trim().split('\n').pop() || 'Video Download';

        log('SUCCESS', `[${id}] Download selesai: ${matched} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
        resolve({
          filePath,
          title,
          fileSize: stats.size
        });
      } catch (err) {
        cleanStrayTempFiles(uniquePrefix);
        reject(err);
      }
    });
  });
}

/**
 * Download audio murni (MP3) dari URL menggunakan yt-dlp & FFmpeg secara teroptimasi.
 * @param {string} url URL media
 * @param {string} id ID transaksi unik
 * @returns {Promise<{ filePath: string, title: string, fileSize: number }>}
 */
function executeDownloadAudio(url, id) {
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
      '--extractor-args', 'youtube:player_client=android,ios,web',
      '--concurrent-fragments', '4',
      '-f', 'ba/b',
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '5', // Preset VBR cepat, hemat beban CPU
      '--socket-timeout', '15',
      '--retries', '3',
      '--fragment-retries', '3',
      '--buffer-size', '32K',
      '--no-mtime',
      '--output', outputTemplate,
      '--print', 'after_move:title',
      url
    ];

    if (ffmpegBin && fs.existsSync(ffmpegBin)) {
      const ffmpegDir = fs.statSync(ffmpegBin).isDirectory() ? ffmpegBin : path.dirname(ffmpegBin);
      args.splice(args.length - 1, 0, '--ffmpeg-location', ffmpegDir);
    }

    const cookiesFile = path.join(__dirname, 'cookies.txt');
    if (fs.existsSync(cookiesFile)) {
      args.splice(args.length - 1, 0, '--cookies', cookiesFile);
    }

    log('INFO', `[${id}] Memulai concurrent download audio: ${url}`);

    let stdout = '';
    let stderr = '';
    const proc = spawn(ytdlpBin, args, { windowsHide: true });

    let isTimedOut = false;
    const timeout = setTimeout(() => {
      isTimedOut = true;
      try { proc.kill('SIGKILL'); } catch (_) {}
      cleanStrayTempFiles(uniquePrefix);
      reject(new Error('TIMEOUT'));
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
      log('ERROR', `[${id}] Gagal menjalankan yt-dlp audio: ${err.message}`);
      reject(new Error('YTDLP_NOT_FOUND'));
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (isTimedOut) return;

      if (code !== 0) {
        cleanStrayTempFiles(uniquePrefix);
        log('WARN', `[${id}] yt-dlp audio exit code ${code}. Stderr: ${stderr.trim().slice(-200)}`);
        const lowerErr = stderr.toLowerCase();
        if (lowerErr.includes('file is larger than max-filesize') || lowerErr.includes('larger than max-filesize')) {
          return reject(new Error('FILE_TOO_LARGE'));
        }
        if (lowerErr.includes('unsupported url') || lowerErr.includes('is not a valid url')) {
          return reject(new Error('INVALID_URL'));
        }
        return reject(new Error('DOWNLOAD_FAILED'));
      }

      try {
        const files = fs.readdirSync(config.downloadDir);
        const matched = files.find((f) => (f.startsWith(uniquePrefix + '.') || f.startsWith(id + '.')) && !f.endsWith('.part') && !f.endsWith('.ytdl') && f !== '.gitkeep');

        if (!matched) {
          cleanStrayTempFiles(uniquePrefix);
          return reject(new Error('FILE_NOT_FOUND'));
        }

        const filePath = path.join(config.downloadDir, matched);
        const stats = fs.statSync(filePath);

        if (stats.size > config.maxFileSizeMB * 1024 * 1024) {
          deleteFileSafe(filePath);
          cleanStrayTempFiles(uniquePrefix);
          return reject(new Error('FILE_TOO_LARGE'));
        }

        const title = stdout.trim().split('\n').pop() || 'Audio Download';

        log('SUCCESS', `[${id}] Download audio selesai: ${matched} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
        resolve({
          filePath,
          title,
          fileSize: stats.size
        });
      } catch (err) {
        cleanStrayTempFiles(uniquePrefix);
        reject(err);
      }
    });
  });
}

/**
 * Menjalankan proses download video secara konkuren tanpa antrean global yang saling memblokir antar user.
 * @param {string} url URL video
 * @param {string} id ID transaksi unik
 * @param {string} [userId='guest'] ID user pemohon
 * @returns {Promise<{ filePath: string, title: string, fileSize: number }>}
 */
function downloadVideo(url, id, userId = 'guest') {
  return downloadQueue.enqueue(() => executeDownload(url, id), userId);
}

/**
 * Menjalankan proses download audio murni secara konkuren.
 * @param {string} url URL media
 * @param {string} id ID transaksi unik
 * @param {string} [userId='guest'] ID user pemohon
 * @returns {Promise<{ filePath: string, title: string, fileSize: number }>}
 */
function downloadAudio(url, id, userId = 'guest') {
  return downloadQueue.enqueue(() => executeDownloadAudio(url, id), userId);
}

module.exports = {
  checkYtDlpAvailable,
  getVideoMetadata,
  downloadVideo,
  downloadAudio,
  downloadQueue,
  processVideoForWhatsApp
};
