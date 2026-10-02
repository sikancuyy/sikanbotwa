/**
 * Centralized Error Handler & Logger untuk Bot Downloader.
 * Mengklasifikasikan error dari yt-dlp, FFmpeg, HTTP request, dan API eksternal
 * ke dalam kategori standar, membedakan transient (bisa di-retry) vs permanent,
 * serta menghasilkan pesan user-friendly tanpa mengekspos error teknis mentah ke chat WhatsApp.
 */

const { log } = require('../utils');

// Kategori error standar
const ERROR_CATEGORIES = {
  NETWORK_ERROR: 'NETWORK_ERROR',
  TIMEOUT: 'TIMEOUT',
  RATE_LIMIT: 'RATE_LIMIT',
  CLOUDFLARE: 'CLOUDFLARE',
  INVALID_URL: 'INVALID_URL',
  NOT_FOUND: 'NOT_FOUND',
  AGE_RESTRICTED: 'AGE_RESTRICTED',
  LOGIN_REQUIRED: 'LOGIN_REQUIRED',
  DOWNLOAD_ERROR: 'DOWNLOAD_ERROR',
  FFMPEG_ERROR: 'FFMPEG_ERROR',
  FILE_ERROR: 'FILE_ERROR',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR'
};

/**
 * Mengklasifikasikan error ke dalam kategori standar
 * @param {Error|object|string} err Objek error atau pesan error
 * @param {object} [context={}] Konteks tambahan (platform, url, dll)
 * @returns {{ category: string, isRetryable: boolean, userMessage: string, detail: string }}
 */
function classifyError(err, context = {}) {
  if (!err) {
    return {
      category: ERROR_CATEGORIES.UNKNOWN_ERROR,
      isRetryable: false,
      userMessage: 'Terjadi kesalahan sistem yang tidak diketahui.',
      detail: ''
    };
  }

  // Jika error sudah memiliki kategori yang disematkan secara eksplisit
  if (err.category && ERROR_CATEGORIES[err.category]) {
    return {
      category: err.category,
      isRetryable: isRetryableCategory(err.category),
      userMessage: getUserMessageForCategory(err.category, context),
      detail: err.message || ''
    };
  }

  const msg = String(err.message || err.stderr || err).toLowerCase();
  const code = String(err.code || '').toUpperCase();
  const status = err.response?.status || err.status || 0;

  // 1. CLOUDFLARE
  if (
    status === 403 && (msg.includes('cloudflare') || msg.includes('cf-ray') || msg.includes('just a moment')) ||
    msg.includes('cloudflare') ||
    msg.includes('cf-chl-bypass') ||
    msg.includes('turnstile') ||
    msg.includes('captcha') ||
    msg.includes('challenge-running') ||
    (status === 403 && context.platform === 'tiktok')
  ) {
    return {
      category: ERROR_CATEGORIES.CLOUDFLARE,
      isRetryable: false,
      userMessage: '⚠️ Layanan sedang mengalami pembatasan proteksi Cloudflare. Silakan coba kembali nanti.',
      detail: msg.slice(0, 150)
    };
  }

  // 2. AGE RESTRICTION
  if (
    msg.includes('confirm your age') ||
    msg.includes('age-restricted') ||
    msg.includes('age restricted') ||
    msg.includes('inappropriate for some users')
  ) {
    return {
      category: ERROR_CATEGORIES.AGE_RESTRICTED,
      isRetryable: false,
      userMessage: '🔞 Video ini memiliki batasan usia (age-restricted) sehingga tidak dapat diunduh tanpa login.',
      detail: msg.slice(0, 150)
    };
  }

  // 3. LOGIN / COOKIES REQUIRED
  if (
    msg.includes('sign in to confirm') ||
    msg.includes('not a bot') ||
    msg.includes('login required') ||
    msg.includes('cookies') ||
    msg.includes('po_token') ||
    msg.includes('gvs po token')
  ) {
    return {
      category: ERROR_CATEGORIES.LOGIN_REQUIRED,
      isRetryable: false,
      userMessage: '🔒 Konten ini memerlukan verifikasi login / cookies akun dari platform sumber.',
      detail: msg.slice(0, 150)
    };
  }

  // 4. NOT FOUND / UNAVAILABLE / PRIVATE
  if (
    status === 404 ||
    msg.includes('unavailable') ||
    msg.includes('private video') ||
    msg.includes('this video has been removed') ||
    msg.includes('tidak ditemukan') ||
    msg.includes('not found') ||
    msg.includes('deleted') ||
    msg.includes('does not exist') ||
    msg.includes('konten tidak tersedia')
  ) {
    return {
      category: ERROR_CATEGORIES.NOT_FOUND,
      isRetryable: false,
      userMessage: '🔍 Konten tidak ditemukan, bersifat privat, atau telah dihapus oleh pemiliknya.',
      detail: msg.slice(0, 150)
    };
  }

  // 5. INVALID URL
  if (
    status === 400 ||
    msg.includes('invalid_url') ||
    msg.includes('is not a valid url') ||
    msg.includes('unsupported url') ||
    msg.includes('url tidak valid') ||
    msg.includes('format url salah')
  ) {
    return {
      category: ERROR_CATEGORIES.INVALID_URL,
      isRetryable: false,
      userMessage: '❌ Format tautan tidak valid atau platform belum didukung.',
      detail: msg.slice(0, 150)
    };
  }

  // 6. FILE TOO LARGE / FILE ERROR
  if (
    msg.includes('file_too_large') ||
    msg.includes('larger than max-filesize') ||
    msg.includes('melebihi batas') ||
    msg.includes('file_not_found') ||
    msg.includes('file kosong')
  ) {
    return {
      category: ERROR_CATEGORIES.FILE_ERROR,
      isRetryable: false,
      userMessage: msg.includes('file_not_found') || msg.includes('file kosong')
        ? '⚠️ File hasil unduhan kosong atau tidak dapat diproses.'
        : '📦 Ukuran file melebihi kapasitas maksimum pengiriman bot.',
      detail: msg.slice(0, 150)
    };
  }

  // 7. RATE LIMIT
  if (
    status === 429 ||
    msg.includes('rate limit') ||
    msg.includes('rate-limit') ||
    msg.includes('too many requests') ||
    msg.includes('429')
  ) {
    return {
      category: ERROR_CATEGORIES.RATE_LIMIT,
      isRetryable: false, // Jangan retry langsung agar tidak memperburuk rate limit
      userMessage: '⏳ Server sumber sedang membatasi frekuensi request (rate limit). Silakan tunggu sejenak.',
      detail: msg.slice(0, 150)
    };
  }

  // 8. TIMEOUT
  if (
    code === 'ETIMEDOUT' ||
    code === 'ECONNABORTED' ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('timedout')
  ) {
    return {
      category: ERROR_CATEGORIES.TIMEOUT,
      isRetryable: true,
      userMessage: '⏳ Waktu pemrosesan habis (timeout). Server sumber lambat merespons, silakan coba beberapa saat lagi.',
      detail: msg.slice(0, 150)
    };
  }

  // 9. NETWORK ERROR
  if (
    ['ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ECONNREFUSED'].includes(code) ||
    msg.includes('socket hang up') ||
    msg.includes('network error') ||
    msg.includes('econnreset') ||
    msg.includes('enotfound')
  ) {
    return {
      category: ERROR_CATEGORIES.NETWORK_ERROR,
      isRetryable: true,
      userMessage: '📡 Terjadi gangguan koneksi jaringan ke server sumber. Silakan coba kembali.',
      detail: msg.slice(0, 150)
    };
  }

  // 10. FFMPEG ERROR
  if (
    msg.includes('ffmpeg') ||
    msg.includes('codec') ||
    msg.includes('konversi') ||
    msg.includes('muxing') ||
    msg.includes('conversion failed')
  ) {
    return {
      category: ERROR_CATEGORIES.FFMPEG_ERROR,
      isRetryable: false,
      userMessage: '⚙️ Terjadi kendala saat mengonversi format media ke standar WhatsApp.',
      detail: msg.slice(0, 150)
    };
  }

  // 11. DOWNLOAD ERROR
  if (
    msg.includes('download_failed') ||
    msg.includes('gagal mengunduh') ||
    msg.includes('extractor error')
  ) {
    return {
      category: ERROR_CATEGORIES.DOWNLOAD_ERROR,
      isRetryable: false,
      userMessage: '❌ Gagal mengekstrak media dari server sumber. Silakan periksa kembali link atau gunakan alternatif.',
      detail: msg.slice(0, 150)
    };
  }

  // 12. UNKNOWN
  return {
    category: ERROR_CATEGORIES.UNKNOWN_ERROR,
    isRetryable: false,
    userMessage: '❌ Terjadi kendala saat memproses permintaan. Silakan coba sesaat lagi.',
    detail: msg.slice(0, 150)
  };
}

/**
 * Menentukan apakah kategori error layak untuk di-retry otomatis
 */
function isRetryableCategory(category) {
  return category === ERROR_CATEGORIES.NETWORK_ERROR || category === ERROR_CATEGORIES.TIMEOUT;
}

/**
 * Memberikan pesan ramah bagi pengguna berdasarkan kategori
 */
function getUserMessageForCategory(category, context = {}) {
  const platform = context.platform ? ` ${context.platform}` : '';
  switch (category) {
    case ERROR_CATEGORIES.CLOUDFLARE:
      if (context.platform === 'tiktok' && context.action === 'stalk') {
        return '⚠️ Layanan profil TikTok sedang mengalami pembatasan. Silakan gunakan downloader TikTok dengan format .tt <url>.';
      }
      return `⚠️ Layanan${platform} sedang mengalami pembatasan proteksi Cloudflare. Silakan coba kembali nanti.`;
    case ERROR_CATEGORIES.AGE_RESTRICTED:
      return `🔞 Konten${platform} memiliki batasan usia (age-restricted) sehingga tidak dapat diunduh tanpa login.`;
    case ERROR_CATEGORIES.LOGIN_REQUIRED:
      return `🔒 Konten${platform} memerlukan verifikasi login / cookies akun untuk dapat diunduh.`;
    case ERROR_CATEGORIES.NOT_FOUND:
      return `🔍 Konten${platform} tidak ditemukan, bersifat privat, atau telah dihapus.`;
    case ERROR_CATEGORIES.INVALID_URL:
      return `❌ Format tautan${platform} tidak valid. Pastikan link dapat dibuka di browser publik.`;
    case ERROR_CATEGORIES.FILE_ERROR:
      return '📦 Ukuran file media melebihi batas pengiriman bot WhatsApp.';
    case ERROR_CATEGORIES.RATE_LIMIT:
      return `⏳ Server${platform} sedang membatasi frekuensi unduhan (rate limit). Silakan tunggu 1-2 menit sebelum mencoba kembali.`;
    case ERROR_CATEGORIES.TIMEOUT:
      return `⏳ Waktu pengunduhan habis (timeout). Server${platform} lambat merespons, silakan coba beberapa saat lagi.`;
    case ERROR_CATEGORIES.NETWORK_ERROR:
      return '📡 Gangguan koneksi ke server sumber. Silakan coba kembali.';
    case ERROR_CATEGORIES.FFMPEG_ERROR:
      return '⚙️ Format media tidak kompatibel atau gagal diproses oleh sistem encoder video/audio.';
    case ERROR_CATEGORIES.DOWNLOAD_ERROR:
    default:
      return `❌ Gagal memproses unduhan${platform}. Silakan pastikan link publik dan aktif.`;
  }
}

/**
 * Log error secara ringkas dan terstandarisasi ke console server
 * @param {string} tag Prefix log (misal: 'YT', 'TIKTOK', 'IG')
 * @param {Error|object|string} err
 * @param {string} [contextInfo=''] Keterangan tambahan (URL, query, user)
 */
function logServiceError(tag, err, contextInfo = '') {
  const classified = classifyError(err);
  const contextStr = contextInfo ? ` [${contextInfo}]` : '';
  log('ERROR', `[${tag}] Error: ${classified.category}${contextStr}${classified.detail ? ` (${classified.detail})` : ''}`);
  return classified;
}

/**
 * Log tahapan proses layanan secara ringkas dan rapi
 * @param {string} tag Prefix log (misal: 'YT', 'TIKTOK')
 * @param {string} message Pesan aktivitas
 */
function logServiceEvent(tag, message) {
  log('INFO', `[${tag}] ${message}`);
}

module.exports = {
  ERROR_CATEGORIES,
  classifyError,
  isRetryableCategory,
  getUserMessageForCategory,
  logServiceError,
  logServiceEvent
};
