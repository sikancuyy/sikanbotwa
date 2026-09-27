/**
 * Milestone Reaction Controller untuk WhatsApp (Baileys)
 * Sesuai Spesifikasi Milestone & Threshold Satu Arah:
 * 
 * 🎯 REACTION STATUS:
 * | Tahap                  | Reaction | Frekuensi |
 * | ---------------------- | -------- | --------: |
 * | Memulai (< 50%)        | ⏳        |        1× |
 * | 50%                    | 📥       |        1× |
 * | 70%                    | 🔄       |        1× |
 * | 90%                    | ⚡        |        1× |
 * | Selesai                | ✅        |        1× |
 * | Gagal                  | ❌        |        1× |
 * | Terhenti / System Down | ⚠️       |        1× |
 * 
 * ATURAN TEKNIS:
 * 1. Tidak menggunakan setInterval() atau animation loop.
 * 2. Reaction hanya berubah ketika milestone benar-benar tercapai.
 * 3. Setiap emoji hanya dipasang satu kali.
 * 4. Reaction selalu diberikan pada pesan user sebagai trigger.
 * 5. Tidak ada pesan status/loading dari bot.
 * 6. Tidak ada editMessage untuk status proses.
 * 7. Setelah ✅, ❌, atau ⚠️, proses reaction terkunci.
 * 8. Jika proses gagal sebelum mencapai milestone berikutnya, langsung gunakan ❌.
 * 9. Jika sistem dihentikan/terputus, gunakan ⚠️.
 * 10. Maksimal 5 perubahan reaction untuk proses sukses.
 * 
 * THRESHOLD SATU ARAH:
 * progress < 50%   → ⏳
 * progress >= 50%  → 📥
 * progress >= 70%  → 🔄
 * progress >= 90%  → ⚡
 * download selesai → ✅
 */

const MILESTONE_EMOJIS = {
  1: '⏳', // Memulai / < 50%
  2: '📥', // 50%
  3: '🔄', // 70%
  4: '⚡', // 90%
  5: '✅'  // Selesai
};

const FINAL_REACTIONS = {
  success: '✅',
  berhasil: '✅',
  done: '✅',
  selesai: '✅',
  '✅': '✅',

  error: '❌',
  gagal: '❌',
  fail: '❌',
  failed: '❌',
  '❌': '❌',

  warn: '⚠️',
  warning: '⚠️',
  down: '⚠️',
  terhenti: '⚠️',
  system_down: '⚠️',
  '⚠️': '⚠️'
};

/**
 * Registry active reaction controllers per messageId
 * Map<string, MilestoneReactionController>
 */
const activeReactionControllers = new Map();

/**
 * Ekstraksi target chat dan key dari berbagai tipe parameter input
 */
function extractChatAndKey(m) {
  let chat = '';
  let key = null;

  if (typeof m === 'string') {
    chat = m;
  } else if (m && typeof m === 'object') {
    if (m.key && typeof m.key === 'object') {
      key = m.key;
      chat = m.chat || m.remoteJid || m.key.remoteJid || '';
    } else if (m.id && (m.remoteJid || m.chat)) {
      key = m;
      chat = m.remoteJid || m.chat;
    } else if (m.remoteJid) {
      key = m;
      chat = m.remoteJid;
    }
  }

  const messageId = key?.id || '';
  return { chat, key, messageId };
}

/**
 * Menghitung tingkat milestone (1..5) dari persentase atau nama milestone
 * @param {number|string} progressOrMilestone
 * @returns {number|string} Tingkat milestone 1..5 atau terminal '❌' / '⚠️'
 */
function resolveMilestoneLevel(progressOrMilestone) {
  if (typeof progressOrMilestone === 'number') {
    if (progressOrMilestone >= 100) return 5;
    if (progressOrMilestone >= 90) return 4;
    if (progressOrMilestone >= 70) return 3;
    if (progressOrMilestone >= 50) return 2;
    return 1;
  }

  if (typeof progressOrMilestone === 'string') {
    const trimmed = progressOrMilestone.trim().toLowerCase();

    // Cek jika format persentase misal "50%", "72%"
    const pctMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*%?$/);
    if (pctMatch) {
      const pct = parseFloat(pctMatch[1]);
      return resolveMilestoneLevel(pct);
    }

    if (FINAL_REACTIONS[trimmed] === '❌' || trimmed === 'error' || trimmed === 'gagal' || trimmed === 'fail') {
      return '❌';
    }
    if (FINAL_REACTIONS[trimmed] === '⚠️' || trimmed === 'warn' || trimmed === 'down' || trimmed === 'terhenti') {
      return '⚠️';
    }
    if (FINAL_REACTIONS[trimmed] === '✅' || trimmed === 'done' || trimmed === 'selesai' || trimmed === 'success') {
      return 5;
    }

    // Pemetaan nama milestone
    switch (trimmed) {
      case 'start':
      case 'memulai':
      case 'init':
      case 'loading':
      case 'processing':
      case 'thinking':
      case 'search':
        return 1; // ⏳
      case '50':
      case 'download':
      case 'downloaded':
      case 'unduh':
        return 2; // 📥
      case '70':
      case 'compression':
      case 'compress':
      case 'optimizing':
      case 'processing_media':
        return 3; // 🔄
      case '90':
      case 'ready':
      case 'sending':
      case 'upload':
        return 4; // ⚡
      default:
        return 1;
    }
  }

  return 1;
}

class MilestoneReactionController {
  /**
   * @param {object} sock Baileys socket instance
   * @param {string} chat Target JID
   * @param {object} key Message key dari pesan user trigger
   */
  constructor(sock, chat, key) {
    this.sock = sock;
    this.chat = chat;
    this.key = key;
    this.messageId = key?.id || '';
    this.currentLevel = 0; // 0 = uninitialized, 1 = ⏳, 2 = 📥, 3 = 🔄, 4 = ⚡, 5 = ✅
    this.isLocked = false;
    this.isStopped = false;
    this.reactionHistory = [];
  }

  /**
   * Mengirim reaction emoji ke pesan user secara fail-safe
   * @private
   */
  async _sendReaction(emoji) {
    if (!emoji || !this.sock || !this.chat || !this.key) return;
    if (typeof this.sock.sendMessage !== 'function') return;

    try {
      this.reactionHistory.push(emoji);
      await this.sock.sendMessage(this.chat, {
        react: {
          text: emoji,
          key: this.key
        }
      });
    } catch (_) {
      // Fail-safe: toleransi kegagalan jaringan atau rate-limit reaction
    }
  }

  /**
   * Memulai milestone reaction (tahap Memulai: ⏳)
   */
  async start() {
    if (this.isLocked || this.isStopped || this.currentLevel >= 1) return this;

    this.currentLevel = 1;
    await this._sendReaction(MILESTONE_EMOJIS[1]);
    return this;
  }

  /**
   * Memperbarui progress menggunakan THRESHOLD SATU ARAH.
   * Hanya bereaksi jika level milestone baru LEBIH TINGGI dari level sekarang.
   * Jika meloncat (misal 48% -> 72%), langsung lompat ke milestone tertinggi (🔄 70%) tanpa reaksi perantara.
   * @param {number|string} progressOrMilestone Persentase (0-100) atau nama milestone
   */
  async update(progressOrMilestone) {
    if (this.isLocked || this.isStopped) return;

    const target = resolveMilestoneLevel(progressOrMilestone);

    // Jika target adalah final error atau warning
    if (target === '❌' || target === '⚠️') {
      await this.setFinal(target);
      return;
    }

    const targetLevel = typeof target === 'number' ? target : 1;

    // THRESHOLD SATU ARAH: Hanya update jika level lebih tinggi
    if (targetLevel > this.currentLevel && targetLevel <= 5) {
      this.currentLevel = targetLevel;
      const emoji = MILESTONE_EMOJIS[targetLevel];

      if (targetLevel === 5) {
        // Milestone 5 = Selesai, langsung kunci
        this.isLocked = true;
      }

      await this._sendReaction(emoji);
    }
  }

  /**
   * Menetapkan reaction final (✅, ❌, atau ⚠️) dan MENGUNCI status reaction.
   * Setelah terkunci, tidak ada reaksi tambahan yang dapat dipasang.
   * @param {'success'|'error'|'warn'|'✅'|'❌'|'⚠️'|string} [status='success']
   */
  async setFinal(status = 'success') {
    if (this.isLocked) return;

    // Kunci langsung untuk mencegah perubahan reaksi berikutnya (Aturan 7)
    this.isLocked = true;
    this.isStopped = true;

    const finalEmoji = FINAL_REACTIONS[status] || status || '✅';
    this.currentLevel = finalEmoji === '✅' ? 5 : (finalEmoji === '❌' ? -1 : -2);

    await this._sendReaction(finalEmoji);
  }

  /**
   * Menghentikan controller dan menghapus dari registry
   */
  stop() {
    this.isStopped = true;
    if (this.messageId && activeReactionControllers.get(this.messageId) === this) {
      activeReactionControllers.delete(this.messageId);
    }
  }

  // Getter properti untuk kompatibilitas pengecekan status
  get hasFinal() {
    return this.isLocked;
  }
}

/**
 * Memulai milestone reaction pada PESAN USER yang menjadi trigger.
 * Tahap Memulai: memasang ⏳ (1×)
 * @param {object} sock Baileys socket instance
 * @param {object|string} messageKey Pesan user atau messageKey
 * @param {number|string} [initialProgress] Progress awal opsional (default: 'start' -> ⏳)
 * @returns {MilestoneReactionController} Instance controller
 */
function startReactionProgress(sock, messageKey, initialProgress = 'start') {
  const { chat, key, messageId } = extractChatAndKey(messageKey);

  // Jika ada controller lama yang belum terkunci untuk pesan ini, hentikan dulu
  if (messageId && activeReactionControllers.has(messageId)) {
    const existing = activeReactionControllers.get(messageId);
    existing.stop();
  }

  const controller = new MilestoneReactionController(sock, chat, key);
  if (messageId) {
    activeReactionControllers.set(messageId, controller);
  }

  // Pasang milestone awal (⏳)
  const initialLevel = resolveMilestoneLevel(initialProgress);
  if (typeof initialLevel === 'number' && initialLevel > 1) {
    controller.currentLevel = initialLevel;
    controller._sendReaction(MILESTONE_EMOJIS[initialLevel]).catch(() => {});
  } else {
    controller.start().catch(() => {});
  }

  return controller;
}

/**
 * Memperbarui progress reaction pada pesan user menggunakan threshold satu arah.
 * @param {object|string} messageKey Pesan user, messageKey, atau messageId
 * @param {number|string} progressOrMilestone Persentase (0-100) atau milestone
 */
async function updateReactionProgress(messageKey, progressOrMilestone) {
  if (!messageKey) return;

  if (messageKey instanceof MilestoneReactionController) {
    await messageKey.update(progressOrMilestone);
    return;
  }

  const { messageId } = extractChatAndKey(messageKey);
  const targetId = messageId || (typeof messageKey === 'string' ? messageKey : '');

  if (targetId && activeReactionControllers.has(targetId)) {
    const controller = activeReactionControllers.get(targetId);
    await controller.update(progressOrMilestone);
  }
}

/**
 * Mengunci status reaction dan memasang emoji final (✅ / ❌ / ⚠️) pada PESAN USER.
 * @param {object} [sock] Baileys socket instance
 * @param {object|string} messageKey Pesan user, messageKey, atau messageId
 * @param {'success'|'error'|'warn'|'✅'|'❌'|'⚠️'|string} [status='success']
 */
async function setFinalReaction(sock, messageKey, status = 'success') {
  let actualSock = sock;
  let actualKey = messageKey;
  let actualStatus = status;

  // Mendukung signature fleksibel: setFinalReaction(messageKey, status)
  if (typeof sock === 'object' && sock && !sock.sendMessage && (typeof messageKey === 'string' || FINAL_REACTIONS[messageKey])) {
    actualKey = sock;
    actualStatus = messageKey;
    actualSock = null;
  }

  if (actualKey instanceof MilestoneReactionController) {
    await actualKey.setFinal(actualStatus);
    return;
  }

  const { chat, key, messageId } = extractChatAndKey(actualKey);
  const targetId = messageId || (typeof actualKey === 'string' ? actualKey : '');

  let controller = targetId ? activeReactionControllers.get(targetId) : null;

  if (controller) {
    await controller.setFinal(actualStatus);
  } else {
    // Jika controller tidak ditemukan atau sudah dibersihkan, pasang final reaction langsung
    const finalEmoji = FINAL_REACTIONS[actualStatus] || actualStatus || '✅';
    const s = actualSock || null;
    if (s && chat && key && typeof s.sendMessage === 'function') {
      try {
        await s.sendMessage(chat, {
          react: {
            text: finalEmoji,
            key: key
          }
        });
      } catch (_) {}
    }
  }
}

/**
 * Menghentikan controller reaction dan membersihkannya dari registry.
 * @param {object|string} messageKey Pesan user, messageKey, atau messageId
 */
function stopReaction(messageKey) {
  if (!messageKey) return;

  if (messageKey instanceof MilestoneReactionController) {
    messageKey.stop();
    return;
  }

  const { messageId } = extractChatAndKey(messageKey);
  const targetId = messageId || (typeof messageKey === 'string' ? messageKey : '');

  if (targetId && activeReactionControllers.has(targetId)) {
    const controller = activeReactionControllers.get(targetId);
    controller.stop();
  }
}

/**
 * Membersihkan seluruh controller reaction yang masih aktif (untuk shutdown/testing)
 */
function cleanupAllReactions() {
  for (const controller of activeReactionControllers.values()) {
    controller.stop();
  }
  activeReactionControllers.clear();
}

/**
 * Mengambil controller reaction yang sedang aktif untuk message ID tertentu
 */
function getReactionController(messageKey) {
  const { messageId } = extractChatAndKey(messageKey);
  const targetId = messageId || (typeof messageKey === 'string' ? messageKey : '');
  return activeReactionControllers.get(targetId) || null;
}

// Backward compatibility aliases
const startReactionAnimation = startReactionProgress;
const updateReactionAnimation = updateReactionProgress;
const stopReactionAnimation = stopReaction;
const ReactionAnimator = MilestoneReactionController;

module.exports = {
  MilestoneReactionController,
  ReactionAnimator,
  startReactionProgress,
  startReactionAnimation,
  updateReactionProgress,
  updateReactionAnimation,
  setFinalReaction,
  stopReaction,
  stopReactionAnimation,
  cleanupAllReactions,
  getReactionController,
  extractChatAndKey,
  resolveMilestoneLevel,
  MILESTONE_EMOJIS,
  FINAL_REACTIONS
};
