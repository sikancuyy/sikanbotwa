/**
 * Helper Anti-Resend & Message Deduplication untuk SikanBot WhatsApp
 * 
 * Mencegah bot mengirim pesan ganda / duplikat akibat:
 * 1. Baileys `messages.upsert` yang memicu event berulang untuk message id yang sama
 * 2. WhatsApp message delivery retries / acknowledgement delay dari server WhatsApp
 * 3. Pantulan pesan keluar milik bot sendiri (fromMe: true echo)
 * 4. Respon terhadap pesan antrean lama saat bot baru menyala atau baru reconnect
 * 5. Zombie socket instances saat reconnect
 */

// Cache message ID yang sudah diproses (Key: compositeKey / id -> Timestamp)
const PROCESSED_MESSAGES = new Map();

// Cache ID pesan yang dikirim oleh bot (Key: id -> Timestamp)
const SENT_MESSAGES = new Map();

// Cache event grup (Key: groupId_action_participant -> Timestamp)
const GROUP_EVENTS = new Map();

const MAX_CACHE_SIZE = 2500;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 menit
const MAX_MESSAGE_AGE_MS = 2 * 60 * 1000; // 2 menit (120 detik)

/**
 * Catat ID pesan yang dikirim oleh bot agar tidak diproses balik sebagai input
 * @param {string} msgId - ID pesan WhatsApp
 */
function markMessageSent(msgId) {
  if (!msgId) return;
  SENT_MESSAGES.set(String(msgId), Date.now());
  cleanupCache();
}

/**
 * Cek apakah suatu pesan dikirim oleh bot ini sendiri
 * @param {string} msgId - ID pesan WhatsApp
 * @returns {boolean}
 */
function isMessageSentByBot(msgId) {
  if (!msgId) return false;
  return SENT_MESSAGES.has(String(msgId));
}

/**
 * Periksa apakah pesan adalah duplikat yang sudah pernah / sedang diproses
 * @param {object} msg - Objek pesan Baileys
 * @returns {boolean}
 */
function isDuplicateMessage(msg) {
  if (!msg || !msg.key) return false;
  const id = msg.key.id;
  const remoteJid = msg.key.remoteJid || '';
  if (!id) return false;

  // Jika pesan ini tercatat dikirim oleh bot, tandai sebagai duplikat
  if (isMessageSentByBot(id)) {
    return true;
  }

  const compositeKey = `${remoteJid}:${id}`;
  const now = Date.now();

  if (PROCESSED_MESSAGES.has(compositeKey) || PROCESSED_MESSAGES.has(id)) {
    return true;
  }

  // Tandai pesan sebagai sudah diproses
  PROCESSED_MESSAGES.set(compositeKey, now);
  PROCESSED_MESSAGES.set(id, now);
  cleanupCache();

  return false;
}

/**
 * Periksa apakah pesan adalah pesan lama (misalnya pesan tertunda dari antrean WA saat bot offline)
 * @param {object} msg - Objek pesan Baileys
 * @param {number} maxAgeMs - Batas usia pesan dalam milidetik (default 2 menit)
 * @returns {boolean}
 */
function isOldMessage(msg, maxAgeMs = MAX_MESSAGE_AGE_MS) {
  if (!msg || !msg.messageTimestamp) return false;
  const rawTs = msg.messageTimestamp;
  const tsSec = typeof rawTs === 'number' ? rawTs : (rawTs?.low || rawTs || 0);
  if (!tsSec || tsSec <= 0) return false;

  const msgTimeMs = tsSec * 1000;
  const now = Date.now();
  const diffMs = now - msgTimeMs;

  // Jika pesan lebih tua dari batas yang ditentukan, anggap pesan lama
  if (diffMs > maxAgeMs) {
    return true;
  }

  return false;
}

/**
 * Periksa apakah event grup (member join/leave) adalah duplikat
 * @param {string} groupId - JID grup
 * @param {string} action - 'add' | 'remove'
 * @param {string} participant - JID participant
 * @param {number} windowMs - Jendela waktu duplikasi (default 30 detik)
 * @returns {boolean}
 */
function isDuplicateGroupEvent(groupId, action, participant, windowMs = 30000) {
  if (!groupId || !action || !participant) return false;
  const key = `${groupId}_${action}_${participant}`;
  const now = Date.now();
  const lastTime = GROUP_EVENTS.get(key);

  if (lastTime && (now - lastTime < windowMs)) {
    return true;
  }

  GROUP_EVENTS.set(key, now);
  cleanupCache();
  return false;
}

/**
 * Validasi terpadu apakah pesan harus diabaikan dari pemrosesan bot
 * @param {object} msg - Objek pesan Baileys
 * @param {string[]} prefixes - Daftar prefix command yang valid
 * @returns {boolean}
 */
function shouldIgnoreMessage(msg, prefixes = ['.', '/', '!']) {
  if (!msg || !msg.message) return true;
  if (msg.key?.remoteJid === 'status@broadcast') return true;

  // Abaikan pesan reaction, protocol message (edit/delete/revoke), dan poll update
  if (
    msg.message.reactionMessage ||
    msg.message.protocolMessage ||
    msg.message.pollUpdateMessage
  ) {
    return true;
  }

  // Jika ID pesan ini dikirim oleh bot sendiri
  if (msg.key?.id && isMessageSentByBot(msg.key.id)) {
    return true;
  }

  // Jika pesan fromMe (dikirim dari akun bot WhatsApp sendiri):
  // Hanya proses jika pesan tersebut secara eksplisit merupakan command (diawali prefix).
  // Pesan teks biasa / URL / reaksi dari fromMe TIDAK boleh diproses agar tidak terjadi infinite loop atau kirim ulang.
  if (msg.key?.fromMe) {
    const rawMsg = msg.message;
    const body = (
      rawMsg.conversation ||
      rawMsg.extendedTextMessage?.text ||
      rawMsg.imageMessage?.caption ||
      rawMsg.videoMessage?.caption ||
      rawMsg.documentMessage?.caption ||
      ''
    ).trim();

    const isCommand = prefixes.some((p) => body.startsWith(p));
    if (!isCommand) {
      return true;
    }
  }

  // Abaikan jika pesan terlalu lama (stale queue saat bot restart/reconnect)
  if (isOldMessage(msg)) {
    return true;
  }

  // Abaikan jika pesan ini adalah duplikat yang sudah diproses
  if (isDuplicateMessage(msg)) {
    return true;
  }

  return false;
}

/**
 * Bersihkan entri cache yang sudah usang dari memory
 */
function cleanupCache() {
  if (PROCESSED_MESSAGES.size <= MAX_CACHE_SIZE && SENT_MESSAGES.size <= MAX_CACHE_SIZE && GROUP_EVENTS.size <= MAX_CACHE_SIZE) {
    return;
  }
  const now = Date.now();
  const expiry = now - CACHE_TTL_MS;

  for (const [k, ts] of PROCESSED_MESSAGES.entries()) {
    if (ts < expiry) PROCESSED_MESSAGES.delete(k);
  }
  for (const [k, ts] of SENT_MESSAGES.entries()) {
    if (ts < expiry) SENT_MESSAGES.delete(k);
  }
  for (const [k, ts] of GROUP_EVENTS.entries()) {
    if (ts < expiry) GROUP_EVENTS.delete(k);
  }

  // Pangkas tertua jika masih melebihi batas maksimum
  if (PROCESSED_MESSAGES.size > MAX_CACHE_SIZE) {
    const keys = Array.from(PROCESSED_MESSAGES.keys()).slice(0, 500);
    for (const k of keys) PROCESSED_MESSAGES.delete(k);
  }
  if (SENT_MESSAGES.size > MAX_CACHE_SIZE) {
    const keys = Array.from(SENT_MESSAGES.keys()).slice(0, 500);
    for (const k of keys) SENT_MESSAGES.delete(k);
  }
  if (GROUP_EVENTS.size > MAX_CACHE_SIZE) {
    const keys = Array.from(GROUP_EVENTS.keys()).slice(0, 500);
    for (const k of keys) GROUP_EVENTS.delete(k);
  }
}

/**
 * Kosongkan seluruh cache deduplikasi (berguna untuk testing)
 */
function clearDeduplicationCache() {
  PROCESSED_MESSAGES.clear();
  SENT_MESSAGES.clear();
  GROUP_EVENTS.clear();
}

module.exports = {
  markMessageSent,
  isMessageSentByBot,
  isDuplicateMessage,
  isOldMessage,
  isDuplicateGroupEvent,
  shouldIgnoreMessage,
  clearDeduplicationCache
};
