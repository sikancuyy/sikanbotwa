const config = require('../config');

/**
 * Validasi apakah sebuah string nomor merupakan nomor WhatsApp asli yang valid
 * (Bukan LID, bukan grup JID, bukan internal identifier WhatsApp, bukan kosong)
 * @param {string} phone
 * @returns {boolean}
 */
function isValidUserNumber(phone) {
  if (!phone || typeof phone !== 'string') return false;
  const clean = phone.replace(/[^0-9]/g, '');

  // Minimal 10 digit, maksimal 13 digit untuk umum; khusus nomor Indonesia 628 bisa sampai 14 digit
  if (clean.length < 10 || clean.length > 14) return false;

  // Tidak boleh diawali 0 setelah normalisasi
  if (clean.startsWith('0')) return false;

  // Tolak ID grup WhatsApp (diawali 120363)
  if (clean.startsWith('120363')) return false;

  // Format standar utama (Indonesia):
  // 628xxxxxxxxxx (10 - 14 digit)
  if (clean.startsWith('62')) {
    return /^628[1-9][0-9]{6,10}$/.test(clean);
  }

  // Format nomor internasional resmi (10-13 digit, bukan LID 14-15 digit)
  if (clean.length >= 14) return false;

  return /^[1-9][0-9]{9,12}$/.test(clean);
}

/**
 * Normalisasi nomor WhatsApp ke format standar numerik murni: 628xxxxxxxxxx
 * Tanpa +, spasi, tanda -, atau device suffix (:xx).
 * Mengubah awalan '08' menjadi '628'.
 * @param {string} rawInput
 * @returns {string|null} Nomor hasil normalisasi atau null jika tidak valid
 */
function normalizeUserNumber(rawInput) {
  if (!rawInput) return null;
  let str = String(rawInput).trim();

  // Buang suffix server WhatsApp jika ada (@s.whatsapp.net, @lid, @g.us)
  if (str.includes('@')) {
    const domain = str.split('@')[1];
    // Jika domain secara eksplisit adalah @g.us, @broadcast, @newsletter, ini BUKAN nomor user!
    if (['g.us', 'broadcast', 'newsletter'].includes(domain)) {
      return null;
    }
    str = str.split('@')[0];
  }

  // Buang device ID suffix (:1, :12, :xx dsb)
  if (str.includes(':')) {
    str = str.split(':')[0];
  }

  // Buang semua karakter non-digit
  let digits = str.replace(/[^0-9]/g, '');
  if (!digits) return null;

  // Normalisasi format Indonesia
  // Contoh: 08123456789 -> 628123456789
  if (digits.startsWith('08')) {
    digits = '62' + digits.slice(1);
  } else if (digits.startsWith('8') && digits.length >= 9 && digits.length <= 13) {
    // Kasus ketikan tanpa 0 di depan: 8123456789
    digits = '62' + digits;
  } else if (digits.startsWith('6208')) {
    // Kasus typo 6208 -> 628
    digits = '628' + digits.slice(4);
  }

  return digits;
}

/**
 * Resolver LID ke Nomor WhatsApp Asli jika event/library menggunakan LID.
 * Menggunakan groupMetadata.participants atau sock.store jika tersedia.
 * @param {string} lid
 * @param {object} [sock]
 * @param {object} [groupMetadata]
 * @returns {string|null} Nomor WhatsApp asli (digits) atau null jika gagal
 */
function resolveLidToPhone(lid, sock = null, groupMetadata = null) {
  if (!lid) return null;
  const rawLid = String(lid).trim();
  const cleanLid = rawLid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');

  // 1. Cek di groupMetadata.participants jika ada
  if (groupMetadata && Array.isArray(groupMetadata.participants)) {
    const found = groupMetadata.participants.find((p) => {
      if (!p) return false;
      const pLid = p.lid ? p.lid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '') : '';
      const pId = p.id ? p.id.split('@')[0].split(':')[0].replace(/[^0-9]/g, '') : '';
      return (pLid && pLid === cleanLid) || (pId && pId === cleanLid);
    });

    if (found && found.id && found.id.endsWith('@s.whatsapp.net')) {
      const candidate = normalizeUserNumber(found.id);
      if (isValidUserNumber(candidate)) {
        return candidate;
      }
    }
  }

  // 2. Cek di sock store / contacts jika tersedia
  if (sock) {
    try {
      const contacts = sock.store?.contacts || sock.contacts;
      if (contacts && typeof contacts === 'object') {
        for (const [jid, contact] of Object.entries(contacts)) {
          if (jid.endsWith('@s.whatsapp.net') && (contact.lid === rawLid || contact.lid?.includes(cleanLid))) {
            const candidate = normalizeUserNumber(jid);
            if (isValidUserNumber(candidate)) {
              return candidate;
            }
          }
        }
      }
    } catch (_) {}
  }

  // Jika resolver gagal mendapatkan nomor asli, kembalikan null (jangan menebak)
  return null;
}

/**
 * FUNGSI UTAMA: getUserNumber()
 * Mendapatkan nomor WhatsApp asli pengirim pesan yang sedang menjalankan command.
 * 
 * Aturan ketat:
 * - HANYA dari pengirim pesan sebenarnya
 * - Menolak group remoteJid (@g.us)
 * - Menolak LID (@lid) kecuali berhasil di-resolve ke nomor asli
 * - Menolak quoted message participant, mentionedJid, contact list
 * - Menghasilkan format 628xxxxxxxxxx murni
 * - Mengembalikan null jika nomor tidak dapat dipastikan
 * 
 * @param {object} msg Baileys message object
 * @param {object} [sock] Baileys socket object
 * @param {object} [groupMetadata] Baileys group metadata
 * @returns {string|null} Nomor WhatsApp asli (e.g. '628xxxxxxxxxx') atau null jika tidak dapat dipastikan
 */
function getUserNumber(msg, sock = null, groupMetadata = null) {
  if (!msg || !msg.key) return null;

  const key = msg.key;
  const isGroup = Boolean(key.remoteJid && key.remoteJid.endsWith('@g.us'));

  // 1. Tentukan identifier pengirim pesan yang sebenarnya
  let candidateSender = null;

  if (key.fromMe) {
    // Pesan dari bot sendiri
    const botId = sock?.user?.id || '';
    if (botId) {
      candidateSender = botId;
    } else {
      candidateSender = config.owner?.number ? `${config.owner.number}@s.whatsapp.net` : null;
    }
  } else if (isGroup) {
    // PESAN GRUP:
    // WAJIB diambil HANYA dari key.participant atau msg.participant!
    // JANGAN PERNAH mengambil dari key.remoteJid (karena itu ID grup @g.us)!
    // JANGAN mengambil dari quotedMessage atau mentionedJid!
    candidateSender = key.participant || msg.participant || null;

    if (!candidateSender) {
      return null;
    }
  } else {
    // PRIVATE CHAT (DM):
    // Diambil dari key.remoteJid pengirim langsung
    candidateSender = key.remoteJid;
  }

  if (!candidateSender) return null;

  const senderStr = String(candidateSender).trim();

  // Pastikan bukan ID grup
  if (senderStr.endsWith('@g.us') || senderStr.includes('@g.us')) {
    return null;
  }

  // 2. Tangani jika identifier berupa LID (@lid)
  if (senderStr.endsWith('@lid') || senderStr.includes('@lid')) {
    const resolved = resolveLidToPhone(senderStr, sock, groupMetadata);
    if (resolved && isValidUserNumber(resolved)) {
      return resolved;
    }
    // Jika resolver gagal mendapatkan nomor asli, kembalikan null
    return null;
  }

  // 3. Normalisasi nomor
  const normalized = normalizeUserNumber(senderStr);
  if (!normalized) return null;

  // 4. Validasi apakah hasil normalisasi benar-benar nomor WhatsApp asli
  if (!isValidUserNumber(normalized)) {
    return null;
  }

  return normalized;
}

/**
 * Mendapatkan JID WhatsApp resmi (@s.whatsapp.net) dari pesan atau nomor yang valid
 * @param {object|string} msgOrNumber
 * @param {object} [sock]
 * @param {object} [groupMetadata]
 * @returns {string|null}
 */
function getUserJid(msgOrNumber, sock = null, groupMetadata = null) {
  let num = null;
  if (typeof msgOrNumber === 'object' && msgOrNumber !== null) {
    num = getUserNumber(msgOrNumber, sock, groupMetadata);
  } else {
    num = normalizeUserNumber(msgOrNumber);
    if (!isValidUserNumber(num)) num = null;
  }
  return num ? `${num}@s.whatsapp.net` : null;
}

module.exports = {
  getUserNumber,
  getUserJid,
  normalizeUserNumber,
  isValidUserNumber,
  resolveLidToPhone
};
