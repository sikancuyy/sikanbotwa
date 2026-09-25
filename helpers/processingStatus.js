/**
 * Global Processing Status Helper: WhatsApp Reaction + Native Typing Indicator
 * 
 * Flow:
 * 1. Command Start: React ⏳ + Typing (composing)
 * 2. In Progress: Heartbeat keep-alive composing (tanpa memory leak)
 * 3. Command Done:
 *    - Success: stop typing (paused) + React ✅
 *    - Fail: stop typing (paused) + React ❌
 * 
 * Concurrency Safe: Menggunakan reference counter per chat agar command paralel
 * tidak mematikan typing milik command lain yang masih berjalan.
 * Fail Safe: Kegagalan reaction / presence tidak pernah menyebabkan crash atau menghentikan command.
 */

const processingCounts = new Map(); // chatId -> active command count
const typingIntervals = new Map();  // chatId -> NodeJS.Timeout

/**
 * Ekstraksi chatId dan msg.key secara fleksibel dari berbagai bentuk input
 */
function extractChatAndKey(m) {
  let chat = '';
  let key = null;

  if (typeof m === 'string') {
    chat = m;
  } else if (m && typeof m === 'object') {
    chat = m.chat || m.remoteJid || m.key?.remoteJid || '';
    if (m.key) {
      key = m.key;
    } else if (m.id && (m.remoteJid || m.chat)) {
      key = m;
    }
  }

  return { chat, key };
}

/**
 * Kirim reaksi emoji ke pesan WhatsApp secara fail-safe
 * @param {object} sock - Baileys socket instance
 * @param {object|string} m - Message object atau chat identifier
 * @param {string} emoji - Emoji reaksi (⏳, ✅, ❌, dll)
 */
async function setReaction(sock, m, emoji) {
  if (!sock || typeof sock.sendMessage !== 'function') return;
  const { chat, key } = extractChatAndKey(m);
  if (!chat || !key) return;

  try {
    await sock.sendMessage(chat, {
      react: {
        text: emoji,
        key: key
      }
    });
  } catch (error) {
    // Fail-safe: Status UI tidak boleh menyebabkan command crash
    // console.error('[Reaction error]', error.message);
  }
}

/**
 * Alias untuk setReaction sesuai spesifikasi
 */
const setProcessingReaction = setReaction;

/**
 * Aktifkan indikator sedang mengetik (composing) dengan heartbeat interval
 * Menggunakan reference counter per chat untuk menangani multi-command concurrency
 * @param {object} sock - Baileys socket instance
 * @param {object|string} m - Message object atau chatId
 */
async function startTyping(sock, m) {
  if (!sock || typeof sock.sendPresenceUpdate !== 'function') return;
  const { chat } = extractChatAndKey(m);
  if (!chat) return;

  const currentCount = processingCounts.get(chat) || 0;
  processingCounts.set(chat, currentCount + 1);

  // Jika ini proses pertama di chat, mulai typing dan aktifkan heartbeat
  if (currentCount === 0) {
    try {
      await sock.sendPresenceUpdate('composing', chat);
    } catch (_) {}

    if (!typingIntervals.has(chat)) {
      const interval = setInterval(async () => {
        try {
          if ((processingCounts.get(chat) || 0) > 0) {
            await sock.sendPresenceUpdate('composing', chat);
          }
        } catch (_) {}
      }, 3500);
      typingIntervals.set(chat, interval);
    }
  }
}

/**
 * Hentikan indikator sedang mengetik (composing)
 * Hanya mengirim 'paused' jika semua proses di chat ini telah selesai (count === 0)
 * @param {object} sock - Baileys socket instance
 * @param {object|string} m - Message object atau chatId
 */
async function stopTyping(sock, m) {
  if (!sock || typeof sock.sendPresenceUpdate !== 'function') return;
  const { chat } = extractChatAndKey(m);
  if (!chat) return;

  let currentCount = (processingCounts.get(chat) || 0) - 1;
  if (currentCount <= 0) {
    processingCounts.delete(chat);

    const interval = typingIntervals.get(chat);
    if (interval) {
      clearInterval(interval);
      typingIntervals.delete(chat);
    }

    try {
      await sock.sendPresenceUpdate('paused', chat);
    } catch (_) {}
  } else {
    processingCounts.set(chat, currentCount);
  }
}

/**
 * Mulai status pemrosesan global:
 * 1. Reaction ⏳ pada pesan user
 * 2. Typing indicator (composing)
 * @param {object} sock - Baileys socket instance
 * @param {object} m - Message object
 */
async function startProcessing(sock, m) {
  try {
    await Promise.allSettled([
      setReaction(sock, m, '⏳'),
      startTyping(sock, m)
    ]);
  } catch (error) {
    console.error('Processing status error:', error);
  }
}

/**
 * Hentikan status pemrosesan global:
 * 1. Hentikan typing (paused jika count === 0)
 * 2. Ubah reaction ke ✅ (berhasil) atau ❌ (gagal)
 * @param {object} sock - Baileys socket instance
 * @param {object} m - Message object
 * @param {boolean} isSuccess - Status keberhasilan command
 */
async function stopProcessing(sock, m, isSuccess = true) {
  try {
    await stopTyping(sock, m);
    await setReaction(sock, m, isSuccess ? '✅' : '❌');
  } catch (error) {
    console.error('Stop processing error:', error);
  }
}

/**
 * Helper informasi count proses per chat (untuk testing/monitoring)
 */
function getProcessingCount(chatId) {
  return processingCounts.get(chatId) || 0;
}

/**
 * Helper reset seluruh timer dan counter (untuk cleanup dan testing)
 */
function resetProcessing(chatId) {
  if (chatId) {
    const interval = typingIntervals.get(chatId);
    if (interval) {
      clearInterval(interval);
      typingIntervals.delete(chatId);
    }
    processingCounts.delete(chatId);
  } else {
    for (const interval of typingIntervals.values()) {
      clearInterval(interval);
    }
    typingIntervals.clear();
    processingCounts.clear();
  }
}

module.exports = {
  startProcessing,
  stopProcessing,
  startTyping,
  stopTyping,
  setReaction,
  setProcessingReaction,
  getProcessingCount,
  resetProcessing,
  extractChatAndKey
};
