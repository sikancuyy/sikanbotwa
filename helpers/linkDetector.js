/**
 * Helper modul untuk mendeteksi URL dan platform media secara otomatis.
 * Mendukung ekstraksi tautan baik dengan protokol (http/https) maupun tautan singkat tanpa protokol,
 * serta mengenali asal platform media (TikTok, Instagram, YouTube, Facebook, Twitter/X, CapCut, dll).
 */

const PLATFORM_PATTERNS = [
  {
    platform: 'tiktok',
    name: 'TikTok',
    icon: '✨',
    regex: /(?:https?:\/\/)?(?:(?:vt|vm|www|m|t)\.)?tiktok\.com\/\S+|https?:\/\/(?:v\.)?douyin\.com\/\S+/i,
    domainCheck: /(tiktok\.com|douyin\.com)/i
  },
  {
    platform: 'instagram',
    name: 'Instagram',
    icon: '📸',
    regex: /(?:https?:\/\/)?(?:www\.)?(?:instagram\.com|instagr\.am)\/\S+/i,
    domainCheck: /(instagram\.com|instagr\.am)/i
  },
  {
    platform: 'youtube',
    name: 'YouTube',
    icon: '🎬',
    regex: /(?:https?:\/\/)?(?:(?:www|m)\.)?(?:youtube\.com\/(?:watch\?|shorts\/|v\/|embed\/)|youtu\.be\/|music\.youtube\.com\/)\S+/i,
    domainCheck: /(youtube\.com|youtu\.be)/i
  },
  {
    platform: 'facebook',
    name: 'Facebook',
    icon: '👥',
    regex: /(?:https?:\/\/)?(?:(?:www|m|web|mobile)\.)?(?:facebook\.com|fb\.watch|fb\.com|fb\.gg)\/\S+/i,
    domainCheck: /(facebook\.com|fb\.watch|fb\.com|fb\.gg)/i
  },
  {
    platform: 'twitter',
    name: 'Twitter (X)',
    icon: '🐦',
    regex: /(?:https?:\/\/)?(?:(?:www|mobile)\.)?(?:twitter\.com|x\.com)\/\S+/i,
    domainCheck: /(twitter\.com|x\.com)/i
  },
  {
    platform: 'threads',
    name: 'Threads',
    icon: '🧵',
    regex: /(?:https?:\/\/)?(?:www\.)?threads\.net\/\S+/i,
    domainCheck: /threads\.net/i
  },
  {
    platform: 'capcut',
    name: 'CapCut',
    icon: '✂️',
    regex: /(?:https?:\/\/)?(?:www\.)?capcut\.(?:com|net)\/\S+/i,
    domainCheck: /capcut\.(com|net)/i
  },
  {
    platform: 'pinterest',
    name: 'Pinterest',
    icon: '📌',
    regex: /(?:https?:\/\/)?(?:(?:www\.)?pinterest\.(?:com|co\.[a-z]{2}|[a-z]{2})|pin\.it)\/\S+/i,
    domainCheck: /(pinterest\.|pin\.it)/i
  },
  {
    platform: 'mediafire',
    name: 'MediaFire',
    icon: '📦',
    regex: /(?:https?:\/\/)?(?:www\.)?mediafire\.com\/\S+/i,
    domainCheck: /mediafire\.com/i
  },
  {
    platform: 'github',
    name: 'GitHub',
    icon: '🐙',
    regex: /(?:https?:\/\/)?github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/i,
    domainCheck: /github\.com/i
  },
  {
    platform: 'snackvideo',
    name: 'SnackVideo',
    icon: '🍿',
    regex: /(?:https?:\/\/)?(?:(?:www\.)?snackvideo\.com|sck\.io)\/\S+/i,
    domainCheck: /(snackvideo\.com|sck\.io)/i
  },
  {
    platform: 'spotify',
    name: 'Spotify',
    icon: '🎵',
    regex: /(?:https?:\/\/)?(?:open\.)?spotify\.com\/\S+/i,
    domainCheck: /spotify\.com/i
  },
  {
    platform: 'soundcloud',
    name: 'SoundCloud',
    icon: '☁️',
    regex: /(?:https?:\/\/)?(?:(?:www|m)\.)?soundcloud\.com\/\S+/i,
    domainCheck: /soundcloud\.com/i
  },
  {
    platform: 'likee',
    name: 'Likee',
    icon: '❤️',
    regex: /(?:https?:\/\/)?(?:(?:www|mobile)\.)?likee\.(?:video|com)\/\S+/i,
    domainCheck: /likee\.(video|com)/i
  },
  {
    platform: 'rednote',
    name: 'RedNote (XiaoHongShu)',
    icon: '📕',
    regex: /(?:https?:\/\/)?(?:(?:www\.)?xiaohongshu\.com|xhslink\.com)\/\S+/i,
    domainCheck: /(xiaohongshu\.com|xhslink\.com|rednote)/i
  },
  {
    platform: 'bilibili',
    name: 'Bilibili (Bstation)',
    icon: '📺',
    regex: /(?:https?:\/\/)?(?:(?:www\.)?bilibili\.(?:tv|com)|bili\.im)\/\S+/i,
    domainCheck: /(bilibili\.(tv|com)|bili\.im)/i
  },
  {
    platform: 'reddit',
    name: 'Reddit',
    icon: '🤖',
    regex: /(?:https?:\/\/)?(?:(?:www|old)\.)?(?:reddit\.com|redd\.it)\/\S+/i,
    domainCheck: /(reddit\.com|redd\.it)/i
  },
  {
    platform: 'dailymotion',
    name: 'Dailymotion',
    icon: '📽️',
    regex: /(?:https?:\/\/)?(?:(?:www\.)?dailymotion\.com|dai\.ly)\/\S+/i,
    domainCheck: /(dailymotion\.com|dai\.ly)/i
  }
];

/**
 * Membersihkan trailing punctuation pada URL yang tidak sengaja tertangkap dari teks.
 * @param {string} url 
 * @returns {string}
 */
function cleanUrl(url) {
  if (!url) return '';
  let cleaned = url.trim();
  // Hilangkan tanda kurung penutup atau tanda baca di akhir URL
  cleaned = cleaned.replace(/[.,;!?)"'>\]}]+$/, '');
  // Pastikan memiliki protokol http atau https
  if (!/^https?:\/\//i.test(cleaned)) {
    cleaned = 'https://' + cleaned;
  }
  return cleaned;
}

/**
 * Mengekstrak URL dari teks pesan.
 * Mendeteksi URL baik dengan http/https maupun domain media populer tanpa protokol.
 * @param {string} text Teks pesan
 * @returns {string|null} URL yang bersih atau null jika tidak ditemukan
 */
function extractUrl(text) {
  if (!text || typeof text !== 'string') return null;

  // 1. Coba pola standar http:// atau https://
  const standardMatch = text.match(/https?:\/\/[^\s<>"'()]+/i);
  if (standardMatch) {
    return cleanUrl(standardMatch[0]);
  }

  // 2. Coba deteksi domain media populer jika user mengirim tanpa https://
  for (const item of PLATFORM_PATTERNS) {
    const match = text.match(item.regex);
    if (match) {
      return cleanUrl(match[0]);
    }
  }

  return null;
}

/**
 * Mengidentifikasi platform dan metadata dari sebuah URL media.
 * @param {string} url URL yang sudah dinormalisasi
 * @returns {{
 *   platform: string,
 *   name: string,
 *   icon: string,
 *   isStory?: boolean,
 *   isShorts?: boolean,
 *   isSupported: boolean
 * }}
 */
function detectPlatform(url) {
  if (!url || typeof url !== 'string') {
    return {
      platform: 'unknown',
      name: 'Media',
      icon: '🎥',
      isSupported: false
    };
  }

  const clean = cleanUrl(url);

  for (const item of PLATFORM_PATTERNS) {
    if (item.domainCheck.test(clean)) {
      const isStory = item.platform === 'instagram' && /instagram\.com\/stories\//i.test(clean);
      const isShorts = item.platform === 'youtube' && /youtube\.com\/shorts\//i.test(clean);

      return {
        platform: item.platform,
        name: isStory ? 'Instagram Story' : (isShorts ? 'YouTube Shorts' : item.name),
        icon: item.icon,
        isStory,
        isShorts,
        isSupported: true
      };
    }
  }

  // URL umum atau domain lain yang mungkin didukung yt-dlp
  const isGenericMedia = /https?:\/\/[^\s]+\.(mp4|mkv|webm|mp3|m4a|wav|ogg)(\?[^\s]*)?$/i.test(clean);
  if (isGenericMedia) {
    return {
      platform: 'direct',
      name: 'Direct Media',
      icon: '🎥',
      isSupported: true
    };
  }

  return {
    platform: 'unknown',
    name: 'Web Link',
    icon: '🌐',
    isSupported: false
  };
}

/**
 * Mengecek apakah URL merupakan URL media yang didukung auto-downloader.
 * @param {string} url 
 * @returns {boolean}
 */
function isSupportedMediaUrl(url) {
  const info = detectPlatform(url);
  return info.isSupported;
}

module.exports = {
  extractUrl,
  cleanUrl,
  detectPlatform,
  isSupportedMediaUrl,
  PLATFORM_PATTERNS
};
