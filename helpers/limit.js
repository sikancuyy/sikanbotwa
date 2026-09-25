const userDb = require('../database/users');
const config = require('../config');
const { normalizeUserNumber, isValidUserNumber } = require('./userHelper');

const UNREGISTERED_DAILY_LIMIT = 10;
const REGISTERED_DAILY_LIMIT = 30;

/**
 * Cek apakah user berhak menjalankan command berlimit
 * @param {string} jid WhatsApp JID user
 * @param {boolean} isOwner Apakah user adalah owner bot
 * @param {boolean} isGroup Apakah command dijalankan di dalam grup
 * @returns {{ allowed: boolean, isUnlimited: boolean, remaining: number, hitsToday: number, maxLimit: number, user: object, message?: string }}
 */
function checkUserLimit(jid, isOwner = false, isGroup = false) {
  const isAdmin = isOwner || userDb.isBotAdmin(jid);

  // Admin Bot dan Owner selalu memiliki akses penuh dan bebas limit (Unlimited)
  if (isAdmin) {
    return {
      allowed: true,
      isUnlimited: true,
      remaining: Infinity,
      hitsToday: 0,
      maxLimit: Infinity,
      user: null
    };
  }

  const cleanPhone = normalizeUserNumber(jid);
  const user = userDb.getUser(jid);

  // Premium / Unlimited status
  if (user && (user.premium === 1 || user.unlimited === 1 || user.limit_type === 'unlimited')) {
    return {
      allowed: true,
      isUnlimited: true,
      remaining: Infinity,
      hitsToday: user.hits_today || 0,
      maxLimit: Infinity,
      user
    };
  }

  // Tentukan batas limit harian berdasarkan status pendaftaran:
  // - Belum terdaftar: maksimal 10 hit/hari
  // - Sudah terdaftar: maksimal 30 hit/hari
  const isRegistered = Boolean(user && user.registered === 1);
  const maxLimit = isRegistered ? REGISTERED_DAILY_LIMIT : UNREGISTERED_DAILY_LIMIT;
  const hitsToday = user ? (user.hits_today || 0) : 0;
  const remaining = Math.max(0, maxLimit - hitsToday);

  if (hitsToday >= maxLimit) {
    const timeLeft = userDb.getTimeUntilMidnightWib();
    const statusLabel = isRegistered ? 'Sudah Terdaftar' : 'Belum Terdaftar';

    let upgradeHint = '';
    if (!isRegistered) {
      upgradeHint = `💡 *Tips:* Daftar akun gratis dengan *.daftar <nama>* untuk menaikkan limit harian menjadi *30 hit/hari*!\n\n`;
    }

    const message =
      `⚠️ *LIMIT HARIAN TERCAPAI* ⚠️\n\n` +
      `Halo kak, kuota penggunaan harian kamu telah habis (${hitsToday}/${maxLimit} hit/hari).\n\n` +
      `📊 *Status Penggunaan:*\n` +
      `• Status Akun  : ${statusLabel}\n` +
      `• Kuota Harian : ${maxLimit} hit/hari\n` +
      `• Terpakai     : ${hitsToday} hit\n` +
      `• Sisa Kuota   : 0 hit\n` +
      `• Reset Dalam  : ${timeLeft.hours} jam ${timeLeft.minutes} menit (Pukul 00:00 WIB)\n\n` +
      `${upgradeHint}` +
      `👑 *UPGRADE PREMIUM (UNLIMITED HIT)* 👑\n` +
      `Bebas limit tanpa batas untuk semua fitur bot:\n` +
      `• *Paket 7 Hari*  : Rp5.000\n` +
      `• *Paket 30 Hari* : Rp10.000\n\n` +
      `Hubungi Owner untuk upgrade: Ketik *.owner* atau *.sewa*`;

    return {
      allowed: false,
      isUnlimited: false,
      remaining: 0,
      hitsToday,
      maxLimit,
      user,
      message
    };
  }

  return {
    allowed: true,
    isUnlimited: false,
    remaining,
    hitsToday,
    maxLimit,
    user
  };
}

/**
 * Mengonsumsi 1 hit limit setelah command berlimit berhasil dieksekusi
 * @param {string} jid
 * @param {boolean} isOwner
 * @param {boolean} isGroup
 */
function consumeUserLimit(jid, isOwner = false, isGroup = false) {
  // Owner dan Admin Bot tidak terkena pengurangan limit
  if (isOwner || userDb.isBotAdmin(jid)) return;

  const cleanPhone = normalizeUserNumber(jid);
  if (!cleanPhone || !isValidUserNumber(cleanPhone)) return;

  const user = userDb.getUser(jid);
  // User Premium / Unlimited tidak mengurangi kuota
  if (user && (user.premium === 1 || user.unlimited === 1 || user.limit_type === 'unlimited')) {
    return;
  }

  userDb.incrementUsage(jid, 1);
}

/**
 * Format status limit user untuk command .limit atau .me
 * @param {string} jid
 * @param {boolean} isOwner
 * @param {boolean} isGroup
 */
function formatUserStatus(jid, isOwner = false, isGroup = false) {
  const isAdmin = isOwner || userDb.isBotAdmin(jid);
  if (isAdmin) {
    const roleName = isOwner ? 'Owner' : 'Admin Bot';
    return (
      `╭───〔 👤 STATUS LIMIT 〕\n` +
      `│\n` +
      `├ Role       : ${roleName}\n` +
      `├ Akses      : Penuh (Full Access)\n` +
      `├ Kuota      : Unlimited ♾️\n` +
      `╰────────────────`
    );
  }

  const user = userDb.getUser(jid);
  const isPrem = Boolean(user && user.premium === 1);
  const isUnlim = isPrem || Boolean(user && (user.unlimited === 1 || user.limit_type === 'unlimited'));

  if (isUnlim) {
    const pkg = user?.premium_package || 'Custom Unlimited';
    let expStr = 'Permanen';
    if (user?.premium_expires_at) {
      const expDate = new Date(user.premium_expires_at);
      expStr = expDate.toLocaleDateString('id-ID') + ' ' + expDate.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    }
    return (
      `╭───〔 👤 STATUS LIMIT 〕\n` +
      `│\n` +
      `├ Status     : Premium VIP 👑\n` +
      `├ Paket      : ${pkg}\n` +
      `├ Kuota      : Unlimited ♾️\n` +
      `├ Kedaluwarsa: ${expStr}\n` +
      `╰────────────────`
    );
  }

  const isRegistered = Boolean(user && user.registered === 1);
  const maxLimit = isRegistered ? REGISTERED_DAILY_LIMIT : UNREGISTERED_DAILY_LIMIT;
  const hitsToday = user ? (user.hits_today || 0) : 0;
  const remaining = Math.max(0, maxLimit - hitsToday);
  const timeLeft = userDb.getTimeUntilMidnightWib();

  return (
    `╭───〔 👤 STATUS LIMIT 〕\n` +
    `│\n` +
    `├ Status     : ${isRegistered ? 'Terdaftar (Registered)' : 'Belum Terdaftar (Guest)'}\n` +
    `├ Limit Hari : ${hitsToday} / ${maxLimit} hit\n` +
    `├ Sisa Kuota : ${remaining} hit\n` +
    `├ Reset Pukul: 00:00 WIB (${timeLeft.hours}j ${timeLeft.minutes}m lagi)\n` +
    `╰────────────────\n\n` +
    `✨ *Paket Premium (Unlimited Hit):*\n` +
    `• Rp5.000 / 7 Hari\n` +
    `• Rp10.000 / 30 Hari\n` +
    `Ketik *.sewa* atau *.owner* untuk berlangganan.`
  );
}

module.exports = {
  MAX_LIMITED_USAGE: UNREGISTERED_DAILY_LIMIT,
  UNREGISTERED_DAILY_LIMIT,
  REGISTERED_DAILY_LIMIT,
  checkUserLimit,
  consumeUserLimit,
  formatUserStatus
};
