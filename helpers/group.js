const { jidNormalizedUser, areJidsSameUser } = require('@whiskeysockets/baileys');

/**
 * Mengambil dan memvalidasi seluruh participant aktif di grup saat ini
 * Selalu mengambil metadata grup terbaru dari socket Baileys
 * @param {object} sock Baileys socket instance
 * @param {string} groupJid ID grup WhatsApp (@g.us)
 * @returns {Promise<{ participants: string[], metadata: object }>}
 */
async function getValidGroupParticipants(sock, groupJid) {
  if (!groupJid || !groupJid.endsWith('@g.us')) {
    throw new Error('JID grup tidak valid.');
  }

  let metadata = null;
  try {
    metadata = await Promise.race([
      sock.groupMetadata(groupJid),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout mengambil metadata grup')), 10000))
    ]);
  } catch (err) {
    console.error(`[GroupHelper] Gagal mengambil metadata grup (${groupJid}):`, err.message);
    throw new Error('❌ Gagal mengambil daftar anggota grup terbaru.');
  }

  if (!metadata || !Array.isArray(metadata.participants)) {
    throw new Error('❌ Gagal mengambil daftar anggota grup terbaru.');
  }

  // 1. Ambil participant aktif
  // 2. Validasi JID (bukan null/undefined/kosong)
  // 3. Normalisasi JID
  // 4. Hapus duplikat
  const rawList = metadata.participants
    .filter((p) => p && p.id && typeof p.id === 'string' && p.id.trim().length > 0)
    .map((p) => jidNormalizedUser(p.id))
    .filter((jid) => jid && jid.includes('@') && !jid.startsWith('0@'));

  const validParticipants = [...new Set(rawList)];

  return {
    participants: validParticipants,
    metadata
  };
}

/**
 * Filter mentions agar hanya berisi participant yang benar-benar aktif di grup
 * @param {string[]} proposedMentions Daftar JID yang diajukan untuk di-mention
 * @param {string[]} activeParticipants Daftar JID participant yang aktif di grup
 * @returns {string[]}
 */
function filterActiveMentions(proposedMentions, activeParticipants) {
  if (!Array.isArray(proposedMentions) || !Array.isArray(activeParticipants)) {
    return [];
  }

  const activeSet = new Set(activeParticipants.map((p) => jidNormalizedUser(p)));
  const cleanList = [];

  for (const raw of proposedMentions) {
    if (!raw) continue;
    const norm = jidNormalizedUser(raw);
    const num = norm.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');

    // Cek kecocokan JID atau kecocokan nomor telepon dalam daftar aktif
    const isPresent = activeSet.has(norm) || activeParticipants.some((p) => {
      const pNorm = jidNormalizedUser(p);
      const pNum = pNorm.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
      return pNorm === norm || (num && pNum === num);
    });

    if (isPresent) {
      cleanList.push(norm);
    }
  }

  return [...new Set(cleanList)];
}

/**
 * Periksa apakah user tertentu merupakan Admin di grup
 * @param {object} groupMetadata Metadata grup
 * @param {string} userJid JID user yang dicek
 * @returns {boolean}
 */
function isGroupAdmin(groupMetadata, userJid) {
  if (!groupMetadata || !Array.isArray(groupMetadata.participants) || !userJid) {
    return false;
  }

  const normUser = jidNormalizedUser(userJid);
  const userNum = normUser.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');

  const member = groupMetadata.participants.find((p) => {
    if (!p || !p.id) return false;
    const pNorm = jidNormalizedUser(p.id);
    const pNum = pNorm.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    const pLid = p.lid ? jidNormalizedUser(p.lid) : '';

    return (
      areJidsSameUser(pNorm, normUser) ||
      (pLid && areJidsSameUser(pLid, normUser)) ||
      (userNum && pNum && userNum === pNum)
    );
  });

  if (!member) return false;
  return member.admin === 'admin' || member.admin === 'superadmin' || Boolean(member.isAdmin) || Boolean(member.isSuperAdmin);
}

/**
 * Periksa apakah Bot merupakan Admin di grup
 * @param {object} groupMetadata Metadata grup
 * @param {object} sock Baileys socket instance
 * @returns {boolean}
 */
function isBotAdmin(groupMetadata, sock) {
  if (!groupMetadata || !Array.isArray(groupMetadata.participants) || !sock) {
    return false;
  }

  const me = sock.user || sock.authState?.creds?.me || {};
  const botId = me.id ? jidNormalizedUser(me.id) : '';
  const botLid = me.lid ? jidNormalizedUser(me.lid) : '';
  const botNum = botId.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');

  const botMember = groupMetadata.participants.find((p) => {
    if (!p || !p.id) return false;
    const pNorm = jidNormalizedUser(p.id);
    const pNum = pNorm.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    const pLid = p.lid ? jidNormalizedUser(p.lid) : '';

    return (
      (botId && areJidsSameUser(pNorm, botId)) ||
      (botLid && areJidsSameUser(pNorm, botLid)) ||
      (pLid && botLid && areJidsSameUser(pLid, botLid)) ||
      (botNum && pNum && botNum === pNum)
    );
  });

  if (!botMember) return false;
  return botMember.admin === 'admin' || botMember.admin === 'superadmin' || Boolean(botMember.isAdmin) || Boolean(botMember.isSuperAdmin);
}

/**
 * Format pesan kick tanpa mention aktif
 * @param {string} userJid
 */
function formatKickMessage(userJid) {
  const num = String(userJid || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
  return `👢 @${num} telah dikeluarkan dari grup.`;
}

module.exports = {
  getValidGroupParticipants,
  filterActiveMentions,
  isGroupAdmin,
  isBotAdmin,
  formatKickMessage
};
