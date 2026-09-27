/**
 * Status Animator Helper untuk WhatsApp (Baileys)
 * Sesuai Spesifikasi Bagian Q:
 * 
 * 1. Emoji status PROSES BOLEH BERULANG selama proses belum selesai.
 * 2. Emoji status berganti secara periodik (~700 - 1000 ms, default: 850 ms).
 * 3. Update status dilakukan dengan MENGEDIT pesan status yang sama.
 * 4. JANGAN mengirim pesan WhatsApp baru untuk setiap pergantian emoji (tanpa spam).
 * 5. Timer/interval dihentikan segera setelah proses selesai, gagal, atau terhenti.
 * 6. Setelah proses selesai, status loading diganti menjadi status FINAL (✅ / ❌ / ⚠️).
 * 7. Status FINAL TIDAK BOLEH BERULANG atau kembali ke animasi loading.
 * 8. Reusable controller: startStatusAnimation, stopStatusAnimation, updateStatus, setFinalStatus.
 */

const EMOJI_SETS = {
  // A. SEDANG MEMPROSES / LOADING: ⏳ → ⚡ → 🔄
  loading: ['⏳', '⚡', '🔄'],
  processing: ['⏳', '⚡', '🔄'],
  process: ['⏳', '⚡', '🔄'],

  // B. SEDANG BERPIKIR / MENCARI DATA: 🤔 → 🔍 → 💡
  thinking: ['🤔', '🔍', '💡'],
  search: ['🤔', '🔍', '💡'],
  mencari: ['🤔', '🔍', '💡'],

  // C. MENERIMA INSTRUKSI / MEMPROSES PESAN: 📩 → ⚙️ → 📤
  receiving: ['📩', '⚙️', '📤'],
  instruction: ['📩', '⚙️', '📤'],
  instruksi: ['📩', '⚙️', '📤'],

  // D. UPLOAD / DOWNLOAD: 📥 → ⏳ → 📑
  download: ['📥', '⏳', '📑'],
  upload: ['📥', '⏳', '📑'],
  unduh: ['📥', '⏳', '📑']
};

const FINAL_EMOJIS = {
  // BERHASIL: ✅
  success: '✅',
  berhasil: '✅',
  done: '✅',

  // GAGAL: ❌
  error: '❌',
  gagal: '❌',
  fail: '❌',
  failed: '❌',

  // TERHENTI / SYSTEM DOWN: ⚠️
  warn: '⚠️',
  warning: '⚠️',
  down: '⚠️',
  terhenti: '⚠️',
  system_down: '⚠️'
};

class StatusAnimator {
  /**
   * @param {object} sock Baileys socket instance
   * @param {string} chatId ID obrolan tujuan
   * @param {object} [quotedMsg=null] Pesan referensi untuk quoted reply (opsional)
   * @param {object} [options={}] Konfigurasi tambahan
   * @param {number} [options.intervalMs=850] Durasi interval pergantian emoji (700-1000 ms)
   */
  constructor(sock, chatId, quotedMsg = null, options = {}) {
    this.sock = sock;
    this.chatId = chatId;
    this.quotedMsg = quotedMsg;
    this.intervalMs = (options && typeof options.intervalMs === 'number' && options.intervalMs >= 20)
      ? options.intervalMs
      : 850; // Periode default 850ms (dalam rentang 700–1000 ms)
    this.statusKey = null;
    this.intervalId = null;
    this.currentType = 'loading';
    this.currentText = 'Memproses...';
    this.frameIndex = 0;
    this.isStopped = false;
    this.hasFinalStatus = false;
    this.isUpdating = false;
    this._startPromise = null;
  }

  /**
   * Memulai animasi status dengan mengirim pesan awal dan menjalankan loop interval.
   * @param {string} [text='Memproses...'] Teks deskripsi status
   * @param {keyof typeof EMOJI_SETS|string} [type='loading'] Kategori set emoji animasi
   */
  async start(text = 'Memproses...', type = 'loading') {
    if (this.hasFinalStatus) return this;
    this.isStopped = false;
    this.currentType = EMOJI_SETS[type] ? type : 'loading';
    this.currentText = text || 'Memproses...';
    this.frameIndex = 0;

    const frames = EMOJI_SETS[this.currentType] || EMOJI_SETS.loading;
    const initialEmoji = frames[0];
    const initialBody = `${initialEmoji} ${this.currentText}`;

    this._startPromise = (async () => {
      try {
        if (this.sock && typeof this.sock.sendMessage === 'function') {
          const sendOpts = this.quotedMsg ? { quoted: this.quotedMsg } : {};
          const sent = await this.sock.sendMessage(this.chatId, { text: initialBody }, sendOpts);
          if (sent?.key) {
            this.statusKey = sent.key;
          }
        }
      } catch (_) {
        // Fail-safe jika pengiriman awal gagal
      }
    })();

    await this._startPromise;

    // Jika telah disuruh stop atau final status sebelum sendMessage selesai, jangan aktifkan loop
    if (this.isStopped || this.hasFinalStatus || !this.statusKey) {
      return this;
    }

    // Jalankan loop perubahan emoji secara periodik
    this._startLoop();
    return this;
  }

  _startLoop() {
    this._clearInterval();
    if (this.isStopped || this.hasFinalStatus || !this.statusKey) return;

    this.intervalId = setInterval(async () => {
      if (this.isStopped || this.hasFinalStatus || !this.statusKey || this.isUpdating) return;
      this.isUpdating = true;

      try {
        const frames = EMOJI_SETS[this.currentType] || EMOJI_SETS.loading;
        this.frameIndex = (this.frameIndex + 1) % frames.length;
        const currentEmoji = frames[this.frameIndex];
        const content = `${currentEmoji} ${this.currentText}`;

        if (this.sock && typeof this.sock.sendMessage === 'function') {
          await this.sock.sendMessage(this.chatId, {
            text: content,
            edit: this.statusKey
          });
        }
      } catch (_) {
        // Toleransi error jaringan/rate-limit saat edit
      } finally {
        this.isUpdating = false;
      }
    }, this.intervalMs);
  }

  /**
   * Mengubah teks atau kategori animasi yang sedang berjalan secara dinamis tanpa membuat interval baru.
   * @param {string} text Teks deskripsi baru
   * @param {keyof typeof EMOJI_SETS|string} [type] Kategori animasi baru (opsional)
   */
  async updateStatus(text, type = null) {
    if (this.hasFinalStatus) return; // Status final tidak boleh ditimpa oleh status proses

    if (text) this.currentText = text;
    if (type && EMOJI_SETS[type]) {
      this.currentType = type;
      this.frameIndex = 0;
    }

    // Update langsung pesan saat ini tanpa membuat timer/interval baru
    if (this.statusKey && !this.isUpdating && !this.isStopped && !this.hasFinalStatus) {
      try {
        const frames = EMOJI_SETS[this.currentType] || EMOJI_SETS.loading;
        const currentEmoji = frames[this.frameIndex];
        if (this.sock && typeof this.sock.sendMessage === 'function') {
          await this.sock.sendMessage(this.chatId, {
            text: `${currentEmoji} ${this.currentText}`,
            edit: this.statusKey
          });
        }
      } catch (_) {}
    }
  }

  _clearInterval() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Menghentikan animasi loop segera (synchronous interval cleanup).
   */
  stop() {
    this.isStopped = true;
    this._clearInterval();
  }

  /**
   * Alias untuk stop() sesuai spesifikasi reusable stopStatusAnimation.
   */
  stopStatusAnimation() {
    this.stop();
  }

  /**
   * Menghentikan animasi dan mengatur status final (✅ / ❌ / ⚠️) sekali saja.
   * Sesuai aturan:
   * 1. Animasi interval DIHENTIKAN SEGERA.
   * 2. Status final dipasang SETELAH animasi dihentikan.
   * 3. Tidak akan terjadi loop atau pergantian emoji lagi.
   * @param {'success'|'error'|'warn'|string} [finalType='success'] Tipe status akhir (success, error, warn)
   * @param {string} [finalText=''] Teks deskripsi status akhir
   */
  async setFinalStatus(finalType = 'success', finalText = '') {
    // 1. Matikan animasi & interval loop terlebih dahulu
    this.stop();

    // 2. Cegah status final dikirim berkali-kali
    if (this.hasFinalStatus) return;
    this.hasFinalStatus = true;

    // 3. Pastikan pengiriman pesan awal telah tuntas jika masih in-flight
    if (this._startPromise) {
      try {
        await this._startPromise;
      } catch (_) {}
    }

    // 4. Tentukan emoji final (✅, ❌, atau ⚠️)
    let finalEmoji = FINAL_EMOJIS[finalType];
    if (!finalEmoji) {
      if (['✅', '❌', '⚠️'].includes(finalType)) {
        finalEmoji = finalType;
      } else {
        finalEmoji = FINAL_EMOJIS.success;
      }
    }

    const defaultText = (finalType === 'success' || finalType === 'berhasil')
      ? 'Selesai.'
      : (finalType === 'warn' || finalType === 'down' || finalType === 'terhenti' || finalType === 'system_down')
        ? 'Sistem sedang mengalami gangguan.'
        : 'Gagal.';

    const body = `${finalEmoji} ${finalText || defaultText}`.trim();

    if (this.statusKey && this.sock && typeof this.sock.sendMessage === 'function') {
      try {
        await this.sock.sendMessage(this.chatId, {
          text: body,
          edit: this.statusKey
        });
      } catch (_) {}
    }
  }
}

/**
 * Factory function untuk membuat instance StatusAnimator baru.
 * @param {object} sock Baileys socket instance
 * @param {string} chatId ID obrolan tujuan
 * @param {object} [quotedMsg=null] Pesan referensi untuk quoted reply
 * @param {object} [options={}] Konfigurasi tambahan
 * @returns {StatusAnimator}
 */
function createStatusAnimator(sock, chatId, quotedMsg = null, options = {}) {
  return new StatusAnimator(sock, chatId, quotedMsg, options);
}

/**
 * Memulai status animation controller dan mengirim pesan pertama.
 * @param {object} sock - Baileys socket instance
 * @param {string} chatId - Target WhatsApp JID
 * @param {string} [text='Memproses...'] - Teks status awal
 * @param {string} [type='loading'] - Kategori emoji proses (loading, thinking, receiving, download)
 * @param {object} [quotedMsg=null] - Pesan referensi untuk quoted reply
 * @param {object} [options={}] - Opsi tambahan (seperti intervalMs)
 * @returns {Promise<StatusAnimator>} Instance StatusAnimator controller
 */
async function startStatusAnimation(sock, chatId, text = 'Memproses...', type = 'loading', quotedMsg = null, options = {}) {
  const animator = new StatusAnimator(sock, chatId, quotedMsg, options);
  await animator.start(text, type);
  return animator;
}

/**
 * Menghentikan animasi status dan membersihkan interval.
 * @param {StatusAnimator} animator
 */
function stopStatusAnimation(animator) {
  if (animator && typeof animator.stop === 'function') {
    animator.stop();
  }
}

/**
 * Mengubah teks deskripsi atau kategori animasi status yang sedang berjalan.
 * @param {StatusAnimator} animator
 * @param {string} text
 * @param {string} [type=null]
 */
async function updateStatus(animator, text, type = null) {
  if (animator && typeof animator.updateStatus === 'function') {
    await animator.updateStatus(text, type);
  }
}

/**
 * Menghentikan animasi dan memasang status final (✅ / ❌ / ⚠️).
 * @param {StatusAnimator} animator
 * @param {'success'|'error'|'warn'|string} [finalType='success']
 * @param {string} [finalText='']
 */
async function setFinalStatus(animator, finalType = 'success', finalText = '') {
  if (animator && typeof animator.setFinalStatus === 'function') {
    await animator.setFinalStatus(finalType, finalText);
  }
}

module.exports = {
  StatusAnimator,
  createStatusAnimator,
  startStatusAnimation,
  stopStatusAnimation,
  updateStatus,
  setFinalStatus,
  EMOJI_SETS,
  FINAL_EMOJIS
};
