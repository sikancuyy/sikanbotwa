const userDb = require('../database/users');
const config = require('../config');

const MAX_LIMITED_USAGE = 50;

/**
 * Cek apakah user berhak menjalankan command berlimit
 * @param {string} jid WhatsApp JID user
 * @param {boolean} isOwner Apakah user adalah owner bot
 * @param {boolean} isGroup Apakah command dijalankan di dalam grup
 * @returns {{ allowed: boolean, isUnlimited: boolean, user: object, remaining: number, message?: string }}
 */
function checkUserLimit(jid, isOwner = false, isGroup = false) {
  const isAdmin = isOwner || userDb.isBotAdmin(jid);

  // Penggunaan di dalam grup, Admin Bot, dan Owner selalu UNLIMITED
  if (isGroup || isAdmin) {
    return {
      allowed: true,
      isUnlimited: true,
      remaining: Infinity,
      user: null
    };
  }

  const user = userDb.getUser(jid);
  if (!user) {
    return {
      allowed: true,
      isUnlimited: false,
      remaining: MAX_LIMITED_USAGE,
      user: null
    };
  }

  const isUnlimited = user.registered === 1 || user.limit_type === 'unlimited';
  if (isUnlimited) {
    return {
      allowed: true,
      isUnlimited: true,
      remaining: Infinity,
      user
    };
  }

  const usage = user.usage_count || 0;
  const remaining = Math.max(0, MAX_LIMITED_USAGE - usage);

  if (usage >= MAX_LIMITED_USAGE) {
    return {
      allowed: false,
      isUnlimited: false,
      remaining: 0,
      user,
      message: `Limit penggunaan kamu sudah habis (${usage}/${MAX_LIMITED_USAGE}).\n\nSilakan lengkapi data pengguna (.daftar <nama>) untuk mendapatkan akses unlimited, atau gunakan bot bebas limit di dalam grup.`
    };
  }

  return {
    allowed: true,
    isUnlimited: false,
    remaining,
    user
  };
}

/**
 * Mengonsumsi 1 limit setelah command berhasil dieksekusi
 * @param {string} jid
 * @param {boolean} isOwner
 * @param {boolean} isGroup
 */
function consumeUserLimit(jid, isOwner = false, isGroup = false) {
  // Jangan kurangi limit jika command dijalankan di grup, oleh owner, atau admin bot
  if (isGroup || isOwner || userDb.isBotAdmin(jid)) return;
  const user = userDb.getUser(jid);
  if (user && user.registered === 0 && user.limit_type !== 'unlimited') {
    userDb.incrementUsage(jid, 1);
  }
}

/**
 * Format status limit user untuk command .limit atau .me
 * @param {string} jid
 * @param {boolean} isOwner
 * @param {boolean} isGroup
 */
function formatUserStatus(jid, isOwner = false, isGroup = false) {
  const user = userDb.getUser(jid);
  const isRegistered = user ? Boolean(user.registered) : false;
  const isUnlimited = isOwner || isRegistered || user?.limit_type === 'unlimited';

  if (isUnlimited) {
    const displayName = (user && user.name) ? user.name : (isOwner ? config.owner.name : '-');
    return `👤 USER STATUS\n\nNama: ${displayName}\nStatus: Unlimited\nPenggunaan: Unlimited`;
  }

  const displayName = (user && user.name) ? user.name : '-';
  const usage = user ? (user.usage_count || 0) : 0;
  const remaining = Math.max(0, MAX_LIMITED_USAGE - usage);

  if (isGroup) {
    return `👤 USER STATUS\n\nNama: ${displayName}\nStatus: Limited (Private Chat)\nPenggunaan: ${usage}/${MAX_LIMITED_USAGE}\nSisa di Private Chat: ${remaining}\nAkses Grup: Bebas Limit (Unlimited ♾️)`;
  }

  return `👤 USER STATUS\n\nNama: ${displayName}\nStatus: Limited\nPenggunaan: ${usage}/${MAX_LIMITED_USAGE}\nSisa: ${remaining}`;
}

module.exports = {
  MAX_LIMITED_USAGE,
  checkUserLimit,
  consumeUserLimit,
  formatUserStatus
};
