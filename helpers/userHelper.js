const config = require('../config');
let groupCacheRef = null;
try {
  groupCacheRef = require('./group').groupCache;
} catch (_) {}

/**
 * Debug logger for phone number resolution
 * Hanya mencetak saat process.env.DEBUG_PHONE_RESOLVER === 'true'
 */
function debugResolver(...args) {
  if (process.env.DEBUG_PHONE_RESOLVER === 'true') {
    console.log('[DEBUG_PHONE_RESOLVER]', ...args);
  }
}

/**
 * 5. VALIDASI NOMOR: isValidPhoneNumber(number)
 * 
 * Memeriksa apakah input merupakan nomor WhatsApp asli yang valid:
 * - Hanya angka setelah normalisasi
 * - Bukan null, undefined, unknown, JID mentah, ID grup (@g.us), atau LID (@lid)
 * - Panjang 10 - 14 digit
 * - Tidak boleh diawali '0' (harus sudah berformat kode negara, misal 62)
 * - Format Indonesia: 62[2-9]... (10 - 14 digit)
 * - Format Internasional resmi: [1-9]... (10 - 14 digit)
 * 
 * @param {string|number} number
 * @returns {boolean}
 */
function isValidPhoneNumber(number) {
  if (number === null || number === undefined) return false;
  if (typeof number !== 'string' && typeof number !== 'number') return false;

  const str = String(number).trim();
  if (!str) return false;

  // Tolak nilai literal null / undefined / unknown / NaN
  if (/^(null|undefined|unknown|nan)$/i.test(str)) return false;

  // Tolak secara eksplisit jika string berakhiran atau mengandung @lid atau @g.us
  if (str.includes('@lid') || str.includes('@g.us') || str.includes('@broadcast') || str.includes('@newsletter')) {
    return false;
  }

  // Bersihkan karakter non-digit
  const clean = str.replace(/[^0-9]/g, '');

  // Minimal 10 digit, maksimal 14 digit untuk nomor telepon WhatsApp
  if (clean.length < 10 || clean.length > 14) return false;

  // Tidak boleh diawali 0 (harus diawali country code)
  if (clean.startsWith('0')) return false;

  // Tolak ID grup WhatsApp (diawali 120363)
  if (clean.startsWith('120363')) return false;

  // Format standar Indonesia: 62[2-9]... (10 - 14 digit)
  if (clean.startsWith('62')) {
    return /^62[2-9][0-9]{7,11}$/.test(clean);
  }

  // Format nomor internasional resmi (10 - 14 digit, bukan LID 15+ digit)
  return /^[1-9][0-9]{9,13}$/.test(clean);
}

/**
 * 6. NORMALISASI: normalizePhoneNumber(number)
 * 
 * Mengubah nomor WhatsApp ke format standar numerik murni: 628xxxxxxxxxx
 * - Menghilangkan suffix device (:xx) dan @s.whatsapp.net
 * - Mengubah '08' menjadi '628'
 * - Mengubah '+62' menjadi '62'
 * - PENTING: JANGAN melakukan normalisasi terhadap LID (@lid)! Mengembalikan null.
 * 
 * @param {string|number} rawInput
 * @returns {string|null} Nomor hasil normalisasi (digits murni) atau null jika tidak valid
 */
function normalizePhoneNumber(rawInput) {
  if (rawInput === null || rawInput === undefined) return null;
  let str = String(rawInput).trim();
  if (!str) return null;

  // Tolak jika literal 'null' / 'undefined' / 'unknown'
  if (/^(null|undefined|unknown|nan)$/i.test(str)) return null;

  // PENTING: JANGAN melakukan normalisasi terhadap LID atau Grup JID!
  // Contoh: 123456789@lid TIDAK BOLEH menjadi 123456789!
  if (str.includes('@lid') || str.includes('@g.us') || str.includes('@broadcast') || str.includes('@newsletter')) {
    return null;
  }

  // Buang server domain @s.whatsapp.net / @c.us jika ada
  if (str.includes('@')) {
    const domain = str.split('@')[1];
    if (domain !== 's.whatsapp.net' && domain !== 'c.us') {
      return null;
    }
    str = str.split('@')[0];
  }

  // Buang device ID suffix (:1, :12, dsb)
  if (str.includes(':')) {
    str = str.split(':')[0];
  }

  // Bersihkan semua karakter non-digit
  let digits = str.replace(/[^0-9]/g, '');
  if (!digits) return null;

  // Tolak ID grup WhatsApp (120363...)
  if (digits.startsWith('120363')) return null;

  // Normalisasi format Indonesia
  if (digits.startsWith('08')) {
    digits = '62' + digits.slice(1);
  } else if (digits.startsWith('8') && digits.length >= 9 && digits.length <= 13) {
    digits = '62' + digits;
  } else if (digits.startsWith('6208')) {
    digits = '628' + digits.slice(4);
  }

  // Validasi akhir
  if (!isValidPhoneNumber(digits)) {
    return null;
  }

  return digits;
}

/**
 * Resolver LID ke Nomor WhatsApp Asli menggunakan mekanisme Baileys & SQLite cache
 * 
 * @param {string} lid Identifier LID WhatsApp (misal: '207945304379644@lid')
 * @param {object} [sock] Baileys socket object
 * @param {object} [groupMetadata] Baileys group metadata
 * @returns {string|null} Nomor WhatsApp asli (digits) atau null jika tidak dapat di-resolve
 */
function resolveLidToPhone(lid, sock = null, groupMetadata = null) {
  if (!lid) return null;
  const rawLid = String(lid).trim();
  const cleanLid = rawLid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
  if (!cleanLid) return null;

  // 1. Cek dari SQLite persistent table lid_mappings (cepat & persisten)
  try {
    const usersDb = require('../database/users');
    if (typeof usersDb.getPhoneByLid === 'function') {
      const cachedPhone = usersDb.getPhoneByLid(cleanLid);
      if (cachedPhone && isValidPhoneNumber(cachedPhone)) {
        debugResolver(`LID ${cleanLid} resolved via DB cache -> ${cachedPhone}`);
        return cachedPhone;
      }
    }
  } catch (_) {}

  // 2. Cek apakah LID adalah milik bot sendiri
  if (sock) {
    try {
      const me = sock.user || sock.authState?.creds?.me;
      const meLid = me?.lid ? String(me.lid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '') : '';
      if (meLid && meLid === cleanLid) {
        const mePhone = normalizePhoneNumber(me.id || me.jid || config.owner?.number);
        if (mePhone && isValidPhoneNumber(mePhone)) {
          saveMappingToDb(cleanLid, mePhone);
          return mePhone;
        }
      }
    } catch (_) {}
  }

  // 3. Cek di groupMetadata.participants jika diberikan
  if (groupMetadata && Array.isArray(groupMetadata.participants)) {
    for (const p of groupMetadata.participants) {
      if (!p) continue;
      const pLid = p.lid ? String(p.lid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '') : (p.id && String(p.id).includes('@lid') ? String(p.id).split('@')[0].split(':')[0].replace(/[^0-9]/g, '') : '');
      const pId = p.id ? String(p.id).split('@')[0].split(':')[0].replace(/[^0-9]/g, '') : '';
      if ((pLid && pLid === cleanLid) || (pId && pId === cleanLid)) {
        const phoneCandidate = p.jid || p.phoneNumber || p.phone_number || (p.id && !String(p.id).includes('@lid') ? p.id : null);
        if (phoneCandidate) {
          const candidate = normalizePhoneNumber(phoneCandidate);
          if (candidate && isValidPhoneNumber(candidate)) {
            saveMappingToDb(cleanLid, candidate);
            debugResolver(`LID ${cleanLid} resolved via groupMetadata -> ${candidate}`);
            return candidate;
          }
        }
      }
    }
  }

  // 4. Cek di memory groupCache jika ada grup lain yang sudah menyimpan data participant
  try {
    let groupCache = groupCacheRef;
    if (!groupCache) {
      const grp = require('./group');
      groupCache = grp.groupCache;
    }
    if (groupCache && typeof groupCache.values === 'function') {
      for (const entry of groupCache.values()) {
        const metadata = entry?.data || entry;
        if (metadata && Array.isArray(metadata.participants)) {
          for (const p of metadata.participants) {
            if (!p) continue;
            const pLid = p.lid ? String(p.lid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '') : (p.id && String(p.id).includes('@lid') ? String(p.id).split('@')[0].split(':')[0].replace(/[^0-9]/g, '') : '');
            const pId = p.id ? String(p.id).split('@')[0].split(':')[0].replace(/[^0-9]/g, '') : '';
            if ((pLid && pLid === cleanLid) || (pId && pId === cleanLid)) {
              const phoneCandidate = p.jid || p.phoneNumber || p.phone_number || (p.id && !String(p.id).includes('@lid') ? p.id : null);
              if (phoneCandidate) {
                const candidate = normalizePhoneNumber(phoneCandidate);
                if (candidate && isValidPhoneNumber(candidate)) {
                  saveMappingToDb(cleanLid, candidate);
                  debugResolver(`LID ${cleanLid} resolved via groupCache -> ${candidate}`);
                  return candidate;
                }
              }
            }
          }
        }
      }
    }
  } catch (_) {}

  // 5. Cek di Baileys contacts store jika tersedia
  if (sock) {
    try {
      const contacts = sock.store?.contacts || sock.contacts;
      if (contacts && typeof contacts === 'object') {
        for (const [jid, contact] of Object.entries(contacts)) {
          const cLid = contact.lid ? String(contact.lid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '') : '';
          const cId = contact.id ? String(contact.id).split('@')[0].split(':')[0].replace(/[^0-9]/g, '') : '';
          if ((cLid && cLid === cleanLid) || (cId && cId === cleanLid)) {
            const cand = contact.jid || (jid.endsWith('@s.whatsapp.net') ? jid : null);
            if (cand) {
              const candidate = normalizePhoneNumber(cand);
              if (candidate && isValidPhoneNumber(candidate)) {
                saveMappingToDb(cleanLid, candidate);
                debugResolver(`LID ${cleanLid} resolved via sock.contacts -> ${candidate}`);
                return candidate;
              }
            }
          }
        }
      }
    } catch (_) {}
  }

  // JANGAN PERNAH MENEBAK nomor dari angka LID!
  return null;
}

/**
 * Helper simpan mapping LID -> Phone ke SQLite
 */
function saveMappingToDb(lid, phone) {
  try {
    const usersDb = require('../database/users');
    if (typeof usersDb.saveLidMapping === 'function') {
      usersDb.saveLidMapping(lid, phone);
    }
  } catch (_) {}
}

/**
 * 1. GLOBAL PHONE NUMBER RESOLVER: getRealPhoneNumber(message, sock, groupMetadata)
 * 
 * SATU-SATUNYA sumber nomor HP untuk seluruh sistem SikanBot.
 * 
 * Menangani:
 * - Baileys message object:
 *   • Private chat: mengambil nomor pengirim pesan
 *   • Group chat: mengambil nomor participant (BUKAN remoteJid grup)
 *   • fromMe: mengambil nomor bot / owner
 * - Resolusi LID (@lid) ke nomor WhatsApp asli via Baileys API & SQLite cache
 * - Normalisasi dan validasi nomor
 * - Mengembalikan null jika nomor tidak dapat dipastikan
 * 
 * @param {object|string} message Baileys message object atau string JID/nomor
 * @param {object} [sock] Baileys socket object
 * @param {object} [groupMetadata] Baileys group metadata
 * @returns {string|null} Nomor WhatsApp asli (digits: '628xxxxxxxxxx') atau null jika tidak dapat dipastikan
 */
function getRealPhoneNumber(message, sock = null, groupMetadata = null) {
  if (!message) return null;

  // Kasus 1: Input adalah string JID / nomor
  if (typeof message === 'string') {
    const str = message.trim();
    if (!str) return null;

    // Tolak grup JID
    if (str.endsWith('@g.us') || str.includes('@g.us')) {
      return null;
    }

    // Jika berakhiran LID (@lid), lakukan resolusi
    if (str.endsWith('@lid') || str.includes('@lid')) {
      return resolveLidToPhone(str, sock, groupMetadata);
    }

    // Nomor telepon / JID biasa
    return normalizePhoneNumber(str);
  }

  // Kasus 2: Input adalah Baileys message object (msg)
  if (typeof message === 'object') {
    const key = message.key;
    if (!key) {
      // Objek participant atau contact tanpa key
      if (message.id) return getRealPhoneNumber(message.id, sock, groupMetadata);
      if (message.participant) return getRealPhoneNumber(message.participant, sock, groupMetadata);
      return null;
    }

    const chatId = key.remoteJid || '';
    const isGroup = chatId.endsWith('@g.us');

    // 2.A: Periksa atribut Phone Number (PN) yang disediakan Baileys dari WhatsApp stanza
    // WhatsApp mengirimkan sender_pn / participant_pn saat LID digunakan
    const pnCandidate = key.senderPn || key.participantPn || key.remoteJidPn || message.senderPn || message.participantPn;
    if (pnCandidate) {
      const normPn = normalizePhoneNumber(pnCandidate);
      if (normPn && isValidPhoneNumber(normPn)) {
        const associatedLid = key.senderLid || key.participantLid || (chatId.includes('@lid') ? chatId : null) || (key.participant?.includes('@lid') ? key.participant : null);
        if (associatedLid) {
          saveMappingToDb(associatedLid, normPn);
        }
        return normPn;
      }
    }

    let candidate = null;

    if (key.fromMe) {
      // Pesan dari bot sendiri
      const botId = sock?.user?.id || sock?.authState?.creds?.me?.id || '';
      candidate = botId || (config.owner?.number ? `${config.owner.number}@s.whatsapp.net` : null);
    } else if (isGroup) {
      // PESAN GRUP:
      // HANYA ambil dari key.participant atau message.participant!
      // JANGAN PERNAH mengambil dari key.remoteJid (karena itu ID grup @g.us)!
      candidate = key.participant || message.participant || null;
      if (!candidate) {
        return null;
      }
    } else {
      // PRIVATE CHAT (DM):
      candidate = chatId;
    }

    if (!candidate) return null;

    const candStr = String(candidate).trim();

    // Pastikan bukan ID grup
    if (candStr.endsWith('@g.us') || candStr.includes('@g.us')) {
      return null;
    }

    // Jika berformat LID, resolve LID
    if (candStr.endsWith('@lid') || candStr.includes('@lid')) {
      return resolveLidToPhone(candStr, sock, groupMetadata);
    }

    return normalizePhoneNumber(candStr);
  }

  return null;
}

/**
 * Mengambil nomor WhatsApp user dari reply chat (quoted message)
 * @param {object} msg Baileys message object
 * @param {object} [sock] Baileys socket object
 * @param {object} [groupMetadata] Baileys group metadata
 * @returns {string|null} Nomor WhatsApp (digits) dari reply chat atau null
 */
function getQuotedPhoneNumber(msg, sock = null, groupMetadata = null) {
  if (!msg) return null;

  let rawMessage = msg.message;
  while (
    rawMessage?.ephemeralMessage ||
    rawMessage?.viewOnceMessage ||
    rawMessage?.viewOnceMessageV2 ||
    rawMessage?.documentWithCaptionMessage
  ) {
    rawMessage = (
      rawMessage.ephemeralMessage?.message ||
      rawMessage.viewOnceMessage?.message ||
      rawMessage.viewOnceMessageV2?.message ||
      rawMessage.documentWithCaptionMessage?.message
    );
  }

  const contextInfo =
    rawMessage?.extendedTextMessage?.contextInfo ||
    rawMessage?.imageMessage?.contextInfo ||
    rawMessage?.videoMessage?.contextInfo ||
    rawMessage?.documentMessage?.contextInfo ||
    rawMessage?.stickerMessage?.contextInfo ||
    rawMessage?.audioMessage?.contextInfo ||
    rawMessage?.buttonsResponseMessage?.contextInfo ||
    rawMessage?.templateButtonReplyMessage?.contextInfo ||
    rawMessage?.interactiveResponseMessage?.contextInfo ||
    msg.message?.extendedTextMessage?.contextInfo ||
    msg.quoted?.contextInfo ||
    null;

  // Cek PN langsung di contextInfo jika ada
  if (contextInfo?.participantPn || contextInfo?.remoteJidPn) {
    const norm = normalizePhoneNumber(contextInfo.participantPn || contextInfo.remoteJidPn);
    if (norm && isValidPhoneNumber(norm)) {
      if (contextInfo.participant && String(contextInfo.participant).includes('@lid')) {
        saveMappingToDb(contextInfo.participant, norm);
      }
      return norm;
    }
  }

  let participant =
    contextInfo?.participant ||
    msg.quoted?.sender ||
    msg.quoted?.participant ||
    null;

  if (!participant && msg.quoted?.key) {
    participant = msg.quoted.key.participant || msg.quoted.key.remoteJid;
  }

  if (!participant) return null;

  return getRealPhoneNumber(participant, sock, groupMetadata);
}

/**
 * 12. TAMPILAN: formatPhoneDisplay(number)
 * 
 * Format nomor WhatsApp untuk tampilan publik:
 * - Nomor valid: +628xxxxxxxxxx
 * - Nomor null / tidak dapat di-resolve: "Tidak tersedia"
 * - TIDAK PERNAH menghasilkan "+null" atau "+undefined"!
 * 
 * @param {string|number} number
 * @returns {string} '+628xxxxxxxxxx' atau 'Tidak tersedia'
 */
function formatPhoneDisplay(number) {
  const norm = normalizePhoneNumber(number);
  if (norm && isValidPhoneNumber(norm)) {
    return `+${norm}`;
  }
  return 'Tidak tersedia';
}

/**
 * Mendapatkan JID resmi (@s.whatsapp.net) dari pesan atau nomor
 * @param {object|string} msgOrNumber
 * @param {object} [sock]
 * @param {object} [groupMetadata]
 * @returns {string|null}
 */
function getUserJid(msgOrNumber, sock = null, groupMetadata = null) {
  const num = getRealPhoneNumber(msgOrNumber, sock, groupMetadata);
  return num ? `${num}@s.whatsapp.net` : null;
}

module.exports = {
  // Global primary functions
  getRealPhoneNumber,
  isValidPhoneNumber,
  normalizePhoneNumber,
  formatPhoneDisplay,
  resolveLidToPhone,
  getQuotedPhoneNumber,
  getUserJid,

  // Backward-compatibility aliases
  getUserNumber: getRealPhoneNumber,
  isValidUserNumber: isValidPhoneNumber,
  normalizeUserNumber: normalizePhoneNumber,
  getQuotedUserNumber: getQuotedPhoneNumber
};
