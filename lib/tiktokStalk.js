const axios = require('axios');
const { logServiceEvent, logServiceError, ERROR_CATEGORIES } = require('../helpers/errorHandler');

/**
 * Modul Terisolasi: TikTok Profile Stalker
 * Menangani pengambilan data profil pengguna TikTok secara independen
 * dari modul downloader agar kegagalan atau pemblokiran Cloudflare pada endpoint profil
 * tidak memengaruhi fungsionalitas unduhan video/audio TikTok maupun stabilitas bot.
 */

/**
 * Mengambil profil publik pengguna TikTok
 * @param {string} username Username TikTok (dengan atau tanpa '@')
 * @returns {Promise<object>} Data profil pengguna
 */
async function stalkTikTok(username) {
  const cleanUser = String(username || '').replace(/^@/, '').trim();
  if (!cleanUser) {
    const err = new Error('Username TikTok tidak boleh kosong.');
    err.category = ERROR_CATEGORIES.INVALID_URL;
    throw err;
  }

  logServiceEvent('TIKTOK', `Profile request: @${cleanUser}`);

  // Upaya 1: TikWM User Info API dengan timeout ketat (8 detik)
  try {
    const controller = new AbortController();
    const timeoutTimer = setTimeout(() => controller.abort(), 8000);

    const res = await axios.get(`https://www.tikwm.com/api/user/info?unique_id=${encodeURIComponent(cleanUser)}`, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*'
      },
      validateStatus: (status) => status < 500
    });

    clearTimeout(timeoutTimer);

    // Deteksi Cloudflare / Forbidden 403
    if (res.status === 403 || typeof res.data === 'string' && (res.data.includes('cloudflare') || res.data.includes('Just a moment'))) {
      logServiceEvent('TIKTOK', 'Cloudflare detected on user info endpoint');
      const cfErr = new Error('Layanan profil TikTok sedang mengalami pembatasan.');
      cfErr.category = ERROR_CATEGORIES.CLOUDFLARE;
      throw cfErr;
    }

    if (res.data && res.data.code === 0 && res.data.data) {
      const u = res.data.data.user || {};
      const s = res.data.data.stats || {};
      return {
        nickname: u.nickname || cleanUser,
        username: u.uniqueId || cleanUser,
        avatar: u.avatarLarger || u.avatarMedium || '',
        bio: u.signature || '-',
        followers: s.followerCount || 0,
        following: s.followingCount || 0,
        hearts: s.heartCount || 0,
        videos: s.videoCount || 0,
        verified: Boolean(u.verified)
      };
    }

    if (res.data && res.data.code === -1) {
      const notFoundErr = new Error('User TikTok tidak ditemukan.');
      notFoundErr.category = ERROR_CATEGORIES.NOT_FOUND;
      throw notFoundErr;
    }
  } catch (err) {
    if (err.category) throw err;

    const status = err.response?.status;
    const msg = String(err.message || '').toLowerCase();

    if (status === 403 || msg.includes('403') || msg.includes('cloudflare') || msg.includes('turnstile')) {
      logServiceEvent('TIKTOK', 'Cloudflare detected');
      const cfErr = new Error('Layanan profil TikTok sedang mengalami pembatasan.');
      cfErr.category = ERROR_CATEGORIES.CLOUDFLARE;
      throw cfErr;
    }

    if (msg.includes('aborted') || msg.includes('timeout')) {
      logServiceError('TIKTOK', err, `@${cleanUser}`);
      const timeoutErr = new Error('Waktu pencarian profil TikTok habis.');
      timeoutErr.category = ERROR_CATEGORIES.TIMEOUT;
      throw timeoutErr;
    }

    logServiceError('TIKTOK', err, `@${cleanUser}`);
    throw err;
  }

  // Jika sampai di sini tanpa hasil
  const notFoundErr = new Error('User TikTok tidak ditemukan.');
  notFoundErr.category = ERROR_CATEGORIES.NOT_FOUND;
  throw notFoundErr;
}

module.exports = {
  stalkTikTok
};
