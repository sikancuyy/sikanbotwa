const os = require('os');
const config = require('../config');
const { log } = require('../utils');

/**
 * Deteksi error sementara (transient error) yang layak di-retry.
 * Error permanen (seperti URL tidak valid, file terlalu besar, 404) tidak boleh di-retry.
 * @param {Error|any} err
 * @returns {boolean}
 */
function isTransientError(err) {
  if (!err) return false;
  const msg = String(err.message || err).toLowerCase();
  const code = String(err.code || '').toUpperCase();
  const status = err.response?.status || err.status;

  // Error kode jaringan sementara
  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'].includes(code)) {
    return true;
  }

  // Error status HTTP sementara (Server Error / Gateway / Rate Limit)
  if (status && [429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  // Pola pesan error timeout / network sementara
  if (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('network error') ||
    msg.includes('socket hang up') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('service unavailable') ||
    (msg.includes('server') && (msg.includes('sibuk') || msg.includes('busy') || msg.includes('down')))
  ) {
    return true;
  }

  return false;
}

/**
 * Filter pesan log agar tidak membocorkan informasi sensitif (API key, password, token)
 * @param {string} text
 * @returns {string}
 */
function sanitizeLogText(text) {
  if (!text) return '';
  return String(text)
    .replace(/(key|token|apikey|password|secret|auth)=([a-zA-Z0-9_\-\.]{8,})/gi, '$1=***REDACTED***')
    .replace(/(Bearer\s+)[a-zA-Z0-9_\-\.]{15,}/gi, '$1***REDACTED***');
}

/**
 * Sistem Antrean Tugas Terpadu (Unified Job Queue System)
 * Mengelola request berat/lama secara terkontrol dengan:
 * - Batas concurrency global dan per-user
 * - Status siklus hidup: queued, processing, success, failed, timeout
 * - Retry berbatas dengan exponential backoff untuk error sementara
 * - Idempotensi & deduplikasi job
 * - Penanganan timeout & pelepasan worker otomatis jika stuck
 * - Pembersihan resource di blok finally
 * - Ketahanan terhadap restart/crash aplikasi
 */
class JobQueue {
  constructor(options = {}) {
    const cpus = os.cpus()?.length || 2;
    this.maxConcurrency = options.maxConcurrency || Math.max(4, cpus * 2);
    this.perUserLimit = options.perUserLimit || 2;
    this.defaultTimeoutMs = options.defaultTimeoutMs || 120000;
    this.defaultMaxRetries = options.defaultMaxRetries || 2;

    this.activeJobs = new Map(); // jobId -> JobInfo
    this.userActiveCount = new Map(); // userId -> number
    this.waitQueue = []; // Array of JobInfo
    this.jobKeyMap = new Map(); // jobKey -> Promise (untuk deduplikasi)
    this.db = null; // SQLite database instance (di-inject via setDb)

    this.stats = {
      totalQueued: 0,
      totalSuccess: 0,
      totalFailed: 0,
      totalTimeout: 0,
      totalRetries: 0
    };
  }

  /**
   * Menghubungkan database SQLite untuk pencatatan persisten status antrean
   * dan pemulihan (recovery) saat restart.
   * @param {object} dbInstance Instance better-sqlite3
   */
  setDb(dbInstance) {
    this.db = dbInstance;
    this.initDbTables();
    this.recoverDanglingJobs();
  }

  /**
   * Inisialisasi tabel antrean job di SQLite jika belum ada
   */
  initDbTables() {
    if (!this.db) return;
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS job_queue_logs (
          id TEXT PRIMARY KEY,
          job_key TEXT,
          type TEXT,
          user_id TEXT,
          status TEXT,
          attempts INTEGER DEFAULT 0,
          max_retries INTEGER DEFAULT 2,
          created_at INTEGER,
          started_at INTEGER,
          completed_at INTEGER,
          error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_jq_status ON job_queue_logs(status);
        CREATE INDEX IF NOT EXISTS idx_jq_key ON job_queue_logs(job_key);
      `);
    } catch (e) {
      log('WARN', `[JobQueue] Gagal inisialisasi tabel job_queue_logs: ${e.message}`);
    }
  }

  /**
   * Membersihkan status job yang menggantung akibat restart/crash sebelumnya
   */
  recoverDanglingJobs() {
    if (!this.db) return;
    try {
      const dangling = this.db.prepare(`
        SELECT COUNT(*) as count FROM job_queue_logs WHERE status IN ('queued', 'processing')
      `).get();
      if (dangling && dangling.count > 0) {
        this.db.prepare(`
          UPDATE job_queue_logs
          SET status = 'failed', completed_at = ?, error = 'SYSTEM_RESTARTED'
          WHERE status IN ('queued', 'processing')
        `).run(Date.now());
        log('INFO', `[JobQueue] Berhasil memulihkan ${dangling.count} job menggantung dari sesi sebelum restart.`);
      }
    } catch (_) {}
  }

  /**
   * Log status job ke SQLite (jika DB terhubung)
   */
  persistJobStatus(job, status, error = null) {
    if (!this.db) return;
    try {
      const now = Date.now();
      const errStr = error ? sanitizeLogText(error.message || String(error)) : null;

      this.db.prepare(`
        INSERT INTO job_queue_logs (id, job_key, type, user_id, status, attempts, max_retries, created_at, started_at, completed_at, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          attempts = excluded.attempts,
          started_at = COALESCE(job_queue_logs.started_at, excluded.started_at),
          completed_at = excluded.completed_at,
          error = excluded.error
      `).run(
        job.id,
        job.jobKey || job.id,
        job.type || 'general',
        job.userId || 'guest',
        status,
        job.attempts || 0,
        job.maxRetries || 2,
        job.createdAt || now,
        status === 'processing' ? now : null,
        ['success', 'failed', 'timeout'].includes(status) ? now : null,
        errStr
      );
    } catch (_) {}
  }

  get running() {
    return this.activeJobs.size;
  }

  get activeCount() {
    return this.activeJobs.size;
  }

  get queueCount() {
    return this.waitQueue.length;
  }

  /**
   * Mendapatkan status lengkap antrean untuk monitoring & endpoint API
   */
  getMetrics() {
    return {
      activeWorkers: this.activeJobs.size,
      queuedJobs: this.waitQueue.length,
      maxConcurrency: this.maxConcurrency,
      perUserLimit: this.perUserLimit,
      stats: { ...this.stats }
    };
  }

  /**
   * Memasukkan tugas baru ke dalam antrean.
   * Mendukung deduplikasi job via idempotencyKey/jobKey.
   * 
   * @param {Function} taskFn Fungsi asinkron yang akan dijalankan
   * @param {object} options Opsi antrean { userId, type, jobKey, timeoutMs, maxRetries, onCleanup }
   * @returns {Promise<any>}
   */
  enqueue(taskFn, options = {}) {
    const userId = options.userId || 'guest';
    const type = options.type || 'general';
    const jobKey = options.jobKey || null;
    const timeoutMs = options.timeoutMs || this.defaultTimeoutMs;
    const maxRetries = typeof options.maxRetries === 'number' ? options.maxRetries : this.defaultMaxRetries;
    const onCleanup = options.onCleanup || null;

    // Deduplikasi job: jika ada tugas identik yang sedang queued atau processing, gabungkan promise (idempotent)
    if (jobKey && this.jobKeyMap.has(jobKey)) {
      log('INFO', `[JobQueue] [dedup] Menggunakan job yang sedang aktif untuk key: ${sanitizeLogText(jobKey)}`);
      return this.jobKeyMap.get(jobKey);
    }

    const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    this.stats.totalQueued++;

    const jobPromise = new Promise((resolve, reject) => {
      const job = {
        id: jobId,
        jobKey,
        type,
        userId,
        taskFn,
        resolve,
        reject,
        timeoutMs,
        maxRetries,
        attempts: 0,
        createdAt: Date.now(),
        startedAt: null,
        onCleanup,
        status: 'queued'
      };

      this.persistJobStatus(job, 'queued');
      log('INFO', `[JobQueue] [queued] Job ${jobId} (type: ${type}, user: ${userId}, waitQueue: ${this.waitQueue.length + 1})`);

      const userRunning = this.userActiveCount.get(userId) || 0;

      // Jika kapasitas server masih tersedia dan user belum melebihi limit per-user, langsung jalankan
      if (this.activeJobs.size < this.maxConcurrency && userRunning < this.perUserLimit) {
        this.runJob(job);
      } else {
        this.waitQueue.push(job);
        // Coba proses berikutnya jika ada kapasitas kosong
        if (this.activeJobs.size < this.maxConcurrency) {
          this.processNext();
        }
      }
    });

    if (jobKey) {
      this.jobKeyMap.set(jobKey, jobPromise);
      jobPromise
        .catch(() => {})
        .finally(() => {
          this.jobKeyMap.delete(jobKey);
        });
    }

    return jobPromise;
  }

  /**
   * Menjalankan eksekusi job dengan timeout guard dan penanganan retry
   */
  runJob(job) {
    job.attempts++;
    job.status = 'processing';
    job.startedAt = Date.now();

    this.activeJobs.set(job.id, job);
    this.userActiveCount.set(job.userId, (this.userActiveCount.get(job.userId) || 0) + 1);
    this.persistJobStatus(job, 'processing');

    log('INFO', `[JobQueue] [processing] Job ${job.id} (type: ${job.type}, user: ${job.userId}, attempt: ${job.attempts}/${job.maxRetries + 1}, active: ${this.activeJobs.size}/${this.maxConcurrency})`);

    let isTimedOut = false;
    let timer = null;

    if (job.timeoutMs > 0) {
      timer = setTimeout(() => {
        isTimedOut = true;
        this.handleTimeout(job);
      }, job.timeoutMs);
    }

    Promise.resolve()
      .then(() => job.taskFn({ attempt: job.attempts, jobId: job.id }))
      .then((result) => {
        if (timer) clearTimeout(timer);
        if (isTimedOut) return;

        job.status = 'success';
        this.stats.totalSuccess++;
        this.persistJobStatus(job, 'success');

        const elapsedSec = ((Date.now() - job.startedAt) / 1000).toFixed(2);
        log('SUCCESS', `[JobQueue] [success] Job ${job.id} selesai dalam ${elapsedSec}s`);

        if (typeof job.onCleanup === 'function') {
          try {
            job.onCleanup();
          } catch (_) {}
        }
        this.releaseWorker(job);
        job.resolve(result);
      })
      .catch((err) => {
        if (timer) clearTimeout(timer);
        if (isTimedOut) return;

        this.handleFailure(job, err);
      });
  }

  /**
   * Penanganan saat job gagal dieksekusi
   */
  handleFailure(job, err) {
    const canRetry = job.attempts <= job.maxRetries && isTransientError(err);

    if (canRetry) {
      this.stats.totalRetries++;
      job.status = 'retrying';

      // Exponential backoff dengan jitter: 1s -> 2s -> 4s
      const baseDelay = 1000 * Math.pow(2, job.attempts - 1);
      const jitter = Math.floor(Math.random() * 500);
      const delay = Math.min(10000, baseDelay + jitter);

      log('WARN', `[JobQueue] [retry] Job ${job.id} gagal sementara (${sanitizeLogText(err.message)}). Menjadwalkan retry #${job.attempts} dalam ${delay}ms...`);
      this.persistJobStatus(job, 'retrying', err);

      // Lepaskan slot saat menunggu delay agar worker lain dapat berjalan
      this.releaseWorker(job);

      setTimeout(() => {
        job.status = 'queued';
        const userRunning = this.userActiveCount.get(job.userId) || 0;
        if (this.activeJobs.size < this.maxConcurrency && userRunning < this.perUserLimit) {
          this.runJob(job);
        } else {
          this.waitQueue.unshift(job); // Prioritaskan retry di depan
          this.processNext();
        }
      }, delay);
    } else {
      job.status = 'failed';
      this.stats.totalFailed++;
      this.persistJobStatus(job, 'failed', err);

      log('ERROR', `[JobQueue] [failed] Job ${job.id} gagal: ${sanitizeLogText(err.message)}`);
      if (typeof job.onCleanup === 'function') {
        try {
          job.onCleanup();
        } catch (_) {}
      }
      this.releaseWorker(job);
      job.reject(err);
    }
  }

  /**
   * Penanganan saat job melampaui batas waktu eksekusi (timeout)
   */
  handleTimeout(job) {
    job.status = 'timeout';
    this.stats.totalTimeout++;
    const timeoutErr = new Error(`TIMEOUT: Job melampaui batas waktu eksekusi (${job.timeoutMs / 1000}s)`);
    this.persistJobStatus(job, 'timeout', timeoutErr);

    log('ERROR', `[JobQueue] [timeout] Job ${job.id} timeout (> ${job.timeoutMs / 1000}s). Melepaskan worker slot.`);

    // Panggil cleanup jika tersedia
    if (typeof job.onCleanup === 'function') {
      try {
        job.onCleanup();
      } catch (_) {}
    }

    this.releaseWorker(job);
    job.reject(timeoutErr);
  }

  /**
   * Melepaskan resource worker dan menjalankan antrean berikutnya
   */
  releaseWorker(job) {
    if (this.activeJobs.has(job.id)) {
      this.activeJobs.delete(job.id);
      const currentCount = this.userActiveCount.get(job.userId) || 1;
      if (currentCount <= 1) {
        this.userActiveCount.delete(job.userId);
      } else {
        this.userActiveCount.set(job.userId, currentCount - 1);
      }
    }
    this.processNext();
  }

  /**
   * Mengambil dan memproses item berikutnya dari antrean menunggu (Fair-Share Scheduling)
   */
  processNext() {
    if (this.activeJobs.size >= this.maxConcurrency || this.waitQueue.length === 0) {
      return;
    }

    // Prioritaskan user yang belum mencapai perUserLimit
    const selectedIndex = this.waitQueue.findIndex(
      (j) => (this.userActiveCount.get(j.userId) || 0) < this.perUserLimit
    );

    if (selectedIndex === -1) {
      // Semua job di antrean adalah milik user yang sudah mencapai perUserLimit.
      // Tunggu hingga job aktif user tersebut selesai dan memanggil releaseWorker().
      return;
    }

    const [nextJob] = this.waitQueue.splice(selectedIndex, 1);
    if (nextJob) {
      this.runJob(nextJob);
    }
  }
}

// Instance global JobQueue tunggal yang siap digunakan oleh seluruh fitur bot
const globalJobQueue = new JobQueue({
  maxConcurrency: config.maxConcurrentDownloads ? parseInt(config.maxConcurrentDownloads, 10) : 6,
  perUserLimit: config.perUserConcurrentLimit || 2,
  defaultTimeoutMs: config.downloadTimeoutMs || 120000,
  defaultMaxRetries: 2
});

module.exports = {
  JobQueue,
  globalJobQueue,
  isTransientError,
  sanitizeLogText
};
