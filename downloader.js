const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { resolveBinary, deleteFileSafe, log } = require('./utils');

// Antrean download sederhana untuk mengontrol concurrency
class DownloadQueue {
  constructor(concurrency = 2) {
    this.concurrency = concurrency;
    this.running = 0;
    this.queue = [];
  }

  enqueue(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.processNext();
    });
  }

  processNext() {
    if (this.running >= this.concurrency || this.queue.length === 0) {
      return;
    }

    const { fn, resolve, reject } = this.queue.shift();
    this.running++;

    fn()
      .then((res) => {
        resolve(res);
      })
      .catch((err) => {
        reject(err);
      })
      .finally(() => {
        this.running--;
        this.processNext();
      });
  }

  get activeCount() {
    return this.running;
  }

  get queueCount() {
    return this.queue.length;
  }
}

const downloadQueue = new DownloadQueue(config.maxConcurrentDownloads);

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
      url
    ];

    let stdout = '';
    const proc = spawn(ytdlpBin, args, { windowsHide: true });

    const timer = setTimeout(() => {
      try { proc.kill(); } catch (_) {}
      resolve({ title: 'Video WhatsApp', duration: null });
    }, 15000);

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
 * Fungsi internal download file menggunakan child_process.spawn yt-dlp.
 * @param {string} url URL video
 * @param {string} id ID unik transaksi
 * @returns {Promise<{ filePath: string, title: string, fileSize: number }>}
 */
function executeDownload(url, id) {
  return new Promise((resolve, reject) => {
    const ytdlpBin = resolveBinary(config.ytdlp);
    const ffmpegBin = resolveBinary(config.ffmpeg);

    const outputTemplate = path.join(config.downloadDir, `${id}.%(ext)s`);

    // Argumen download: Prioritaskan MP4 H.264 & AAC agar kompatibel dengan pemutar WhatsApp
    const args = [
      '--no-playlist',
      '--no-warnings',
      '--max-filesize', `${config.maxFileSizeMB}M`,
      // Format seleksi: cari mp4 h264, atau fallback mp4 terbaik
      '-f', 'bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '--output', outputTemplate,
      '--print', 'after_move:title',
      url
    ];

    // Jika ffmpeg terdeteksi atau dikonfigurasi, tambahkan path ffmpeg
    if (ffmpegBin) {
      args.splice(args.length - 1, 0, '--ffmpeg-location', ffmpegBin);
    }

    log('INFO', `[${id}] Memulai download: ${url}`);

    let stdout = '';
    let stderr = '';
    const proc = spawn(ytdlpBin, args, { windowsHide: true });

    let isTimedOut = false;
    const timeout = setTimeout(() => {
      isTimedOut = true;
      try { proc.kill('SIGKILL'); } catch (_) {}
      reject(new Error('TIMEOUT'));
    }, config.downloadTimeoutMs);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      log('ERROR', `[${id}] Gagal menjalankan yt-dlp: ${err.message}`);
      reject(new Error('YTDLP_NOT_FOUND'));
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (isTimedOut) return;

      if (code !== 0) {
        log('WARN', `[${id}] yt-dlp exit code ${code}. Stderr: ${stderr.trim().slice(-200)}`);
        
        // Periksa pesan error spesifik
        const lowerErr = stderr.toLowerCase();
        if (lowerErr.includes('file is larger than max-filesize') || lowerErr.includes('larger than max-filesize')) {
          return reject(new Error('FILE_TOO_LARGE'));
        }
        if (lowerErr.includes('unsupported url') || lowerErr.includes('is not a valid url')) {
          return reject(new Error('INVALID_URL'));
        }
        return reject(new Error('DOWNLOAD_FAILED'));
      }

      // Cari file hasil download di folder downloads
      try {
        const files = fs.readdirSync(config.downloadDir);
        const matched = files.find((f) => f.startsWith(id + '.') && f !== '.gitkeep');

        if (!matched) {
          return reject(new Error('FILE_NOT_FOUND'));
        }

        const filePath = path.join(config.downloadDir, matched);
        const stats = fs.statSync(filePath);

        // Validasi ukuran file sekali lagi terhadap batas WhatsApp
        if (stats.size > config.maxFileSizeMB * 1024 * 1024) {
          deleteFileSafe(filePath);
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
        reject(err);
      }
    });
  });
}

/**
 * Menjalankan proses download dengan antrean (queue) untuk keamanan memori.
 * @param {string} url URL video
 * @param {string} id ID transaksi unik
 * @returns {Promise<{ filePath: string, title: string, fileSize: number }>}
 */
function downloadVideo(url, id) {
  return downloadQueue.enqueue(() => executeDownload(url, id));
}

module.exports = {
  checkYtDlpAvailable,
  getVideoMetadata,
  downloadVideo,
  downloadQueue
};
