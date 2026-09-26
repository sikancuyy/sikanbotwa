const fs = require('fs');
const path = require('path');

/**
 * Memastikan semua folder yang dibutuhkan ada.
 * @param {string[]} dirs Daftar path direktori
 */
function ensureDirs(dirs) {
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

/**
 * Membersihkan file lama di folder sementara (misal sisa crash sebelumnya).
 * @param {string} dirPath Path direktori
 * @param {number} maxAgeMs Umur maksimal file dalam milidetik (default: 30 menit)
 */
function cleanDirectory(dirPath, maxAgeMs = 30 * 60 * 1000) {
  try {
    if (!fs.existsSync(dirPath)) return;
    const now = Date.now();
    const files = fs.readdirSync(dirPath);

    for (const file of files) {
      if (file === '.gitkeep') continue;
      const filePath = path.join(dirPath, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile() && (now - stat.mtimeMs > maxAgeMs)) {
          fs.unlinkSync(filePath);
        }
      } catch (_) {}
    }
  } catch (err) {
    console.error(`[WARN] Gagal membersihkan folder ${dirPath}:`, err.message);
  }
}

/**
 * Mencari lokasi binary (yt-dlp / ffmpeg):
 * Prioritaskan file lokal di folder bot, jika tidak ada gunakan command di PATH.
 * @param {object} binaryConfig Objek konfigurasi { command, localCandidates }
 * @returns {string} Path executable atau nama command
 */
function resolveBinary(binaryConfig) {
  if (!binaryConfig) return '';
  const isWindows = process.platform === 'win32';
  if (isWindows && binaryConfig.localCandidates && Array.isArray(binaryConfig.localCandidates)) {
    for (const candidate of binaryConfig.localCandidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  if (binaryConfig.command && fs.existsSync(binaryConfig.command)) {
    return binaryConfig.command;
  }

  // Cari di system PATH pada Windows agar mendapatkan path absolut (misal WinGet packages)
  if (isWindows && binaryConfig.command) {
    try {
      const { execSync } = require('child_process');
      const cmdName = String(binaryConfig.command).replace(/\.exe$/i, '');
      const out = execSync(`where.exe ${cmdName}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      const firstLine = out.trim().split(/\r?\n/)[0];
      if (firstLine && fs.existsSync(firstLine)) {
        return firstLine;
      }
    } catch (_) {}
  }

  return binaryConfig.command;
}

/**
 * Mengekstrak URL pertama dari sebuah pesan teks.
 * @param {string} text Teks pesan
 * @returns {string|null} URL yang ditemukan atau null
 */
function extractUrl(text) {
  if (!text || typeof text !== 'string') return null;
  const urlRegex = /(https?:\/\/[^\s]+)/i;
  const match = text.match(urlRegex);
  if (!match) return null;

  let url = match[0].trim();
  url = url.replace(/[.,;:!?)]+$/, '');
  return url;
}

/**
 * Memvalidasi apakah URL merupakan link video yang potensial didukung.
 * @param {string} rawUrl URL yang akan dicek
 * @returns {boolean} True jika URL valid
 */
function isValidVideoUrl(rawUrl) {
  if (!rawUrl) return false;
  try {
    const parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return false;
    }

    const host = parsed.hostname.toLowerCase();
    const supportedDomains = [
      'youtube.com', 'youtu.be',
      'tiktok.com',
      'instagram.com',
      'twitter.com', 'x.com',
      'facebook.com', 'fb.watch',
      'pinterest.com', 'pin.it',
      'reddit.com',
      'vimeo.com',
      'dailymotion.com',
      'threads.net',
      'snackvideo.com',
      'bilibili.tv', 'bilibili.com'
    ];

    const isDirectVideo = /\.(mp4|m4v|mov|webm|mkv|avi)($|\?)/i.test(parsed.pathname);
    const isDomainMatch = supportedDomains.some((d) => host === d || host.endsWith('.' + d));

    return isDomainMatch || isDirectVideo || host.length > 3;
  } catch {
    return false;
  }
}

/**
 * Menghapus file secara aman tanpa memicu crash jika file tidak ada.
 * @param {string} filePath Path file yang akan dihapus
 */
function deleteFileSafe(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.error(`[WARN] Gagal menghapus file sementara ${filePath}:`, err.message);
  }
}

/**
 * Format bytes ke ukuran yang mudah dibaca (MB, KB, GB).
 * @param {number} bytes Ukuran dalam bytes
 * @returns {string} String ukuran terformat
 */
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

/**
 * Format detik ke teks uptime.
 * @param {number} seconds Uptime dalam detik
 * @returns {string} Uptime terformat
 */
function formatUptime(seconds) {
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  const parts = [];
  if (d > 0) parts.push(`${d} hari`);
  if (h > 0) parts.push(`${h} jam`);
  if (m > 0) parts.push(`${m} menit`);
  parts.push(`${s} detik`);
  return parts.join(' ');
}

/**
 * Menampilkan banner terminal yang rapi dan konsisten.
 * @param {object} info Informasi status
 */
function printBanner({ status = 'Starting', number = '-', mode = 'Initializing' }) {
  console.log('\n' + '='.repeat(45));
  console.log('            🤖 SIKANBOT v2.0.0 🤖');
  console.log('       Developer: Rahmat Haikal (Owner)');
  console.log('='.repeat(45));
  console.log(`Status  : ${status}`);
  console.log(`Nomor   : ${number}`);
  console.log(`Mode    : ${mode}`);
  console.log('='.repeat(45) + '\n');
}

/**
 * Log dengan format waktu sederhana.
 * @param {string} type Tipe log: INFO, WARN, ERROR, SUCCESS
 * @param {string} message Pesan log
 */
function log(type, message) {
  const time = new Date().toLocaleTimeString('id-ID', { hour12: false });
  console.log(`[${time}] [${type}] ${message}`);
}

/**
 * Menghitung persentase penggunaan CPU server secara real-time.
 * @param {number} sampleMs Lama sampling milidetik (default 60ms)
 * @returns {Promise<number>} Persentase penggunaan CPU (0-100)
 */
function getCpuUsagePercent(sampleMs = 60) {
  const os = require('os');
  return new Promise((resolve) => {
    try {
      const cpus1 = os.cpus();
      if (!cpus1 || !cpus1.length) return resolve(0);
      let idle1 = 0;
      let total1 = 0;
      for (const c of cpus1) {
        for (const t in c.times) total1 += c.times[t];
        idle1 += c.times.idle;
      }

      setTimeout(() => {
        try {
          const cpus2 = os.cpus();
          if (!cpus2 || !cpus2.length) return resolve(0);
          let idle2 = 0;
          let total2 = 0;
          for (const c of cpus2) {
            for (const t in c.times) total2 += c.times[t];
            idle2 += c.times.idle;
          }
          const idleDiff = (idle2 - idle1) / cpus2.length;
          const totalDiff = (total2 - total1) / cpus2.length;
          const percent = totalDiff > 0 ? Math.max(0, Math.min(100, Math.round(100 - (100 * idleDiff / totalDiff)))) : 0;
          resolve(percent);
        } catch (_) {
          resolve(0);
        }
      }, sampleMs);
    } catch (_) {
      resolve(0);
    }
  });
}

/**
 * Membuat visual progress bar baris teks rapi untuk WhatsApp (misal: ██████░░░░).
 * @param {number} percent Persentase nilai (0 - 100)
 * @param {number} length Panjang karakter total (default 10)
 * @returns {string} String progress bar
 */
function createProgressBar(percent, length = 10) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  const filled = Math.round((p / 100) * length);
  const empty = length - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

module.exports = {
  ensureDirs,
  cleanDirectory,
  resolveBinary,
  extractUrl,
  isValidVideoUrl,
  deleteFileSafe,
  formatBytes,
  formatUptime,
  printBanner,
  log,
  getCpuUsagePercent,
  createProgressBar
};
