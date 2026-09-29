const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { JobQueue, isTransientError } = require('../helpers/jobQueue');
const userDb = require('../database/users');

let passedTests = 0;
let totalTests = 0;

function it(name, fn) {
  totalTests++;
  try {
    const res = fn();
    if (res && typeof res.then === 'function') {
      return res
        .then(() => {
          passedTests++;
          console.log(`✅ [PASS] ${name}`);
        })
        .catch((err) => {
          console.error(`❌ [FAIL] ${name}:`, err.message);
          throw err;
        });
    }
    passedTests++;
    console.log(`✅ [PASS] ${name}`);
  } catch (err) {
    console.error(`❌ [FAIL] ${name}:`, err.message);
    throw err;
  }
}

async function runQueueTests() {
  console.log('\n====================================================');
  console.log('🧪 PENGUJIAN SISTEM ANTREAN (QUEUE & CONCURRENCY)');
  console.log('====================================================\n');

  // 1. Uji Deteksi Transient vs Permanent Error
  await it('1. isTransientError mendeteksi error jaringan/timeout sebagai transient dan 404/INVALID_URL sebagai permanen', () => {
    assert.strictEqual(isTransientError(new Error('ETIMEDOUT connection timed out')), true);
    assert.strictEqual(isTransientError({ code: 'ECONNRESET' }), true);
    assert.strictEqual(isTransientError({ response: { status: 503 } }), true);
    assert.strictEqual(isTransientError({ response: { status: 429 } }), true);
    assert.strictEqual(isTransientError(new Error('Server AI sedang sibuk')), true);

    // Non-transient
    assert.strictEqual(isTransientError(new Error('INVALID_URL')), false);
    assert.strictEqual(isTransientError(new Error('FILE_TOO_LARGE')), false);
    assert.strictEqual(isTransientError({ response: { status: 404 } }), false);
    assert.strictEqual(isTransientError({ response: { status: 400 } }), false);
  });

  // 2. Uji Status Siklus Hidup: queued -> processing -> success
  await it('2. Siklus hidup job sukses berjalan tertib (queued, processing, success)', async () => {
    const queue = new JobQueue({ maxConcurrency: 2, perUserLimit: 2 });
    let executionOrder = [];

    const promise = queue.enqueue(async ({ attempt, jobId }) => {
      executionOrder.push('running');
      assert.strictEqual(attempt, 1);
      assert.ok(jobId.startsWith('job_'));
      await new Promise((r) => setTimeout(r, 50));
      return { ok: true, data: 123 };
    }, { userId: 'userA', type: 'test' });

    assert.strictEqual(queue.activeCount, 1);
    const result = await promise;
    assert.deepStrictEqual(result, { ok: true, data: 123 });
    assert.strictEqual(queue.activeCount, 0);
    assert.strictEqual(queue.stats.totalSuccess, 1);
  });

  // 3. Uji Batas Concurrency Global
  await it('3. Batas Concurrency Global: Membatasi worker bersamaan sesuai kapasitas server', async () => {
    const maxConcurrency = 3;
    const queue = new JobQueue({ maxConcurrency, perUserLimit: 10 });
    let maxObservedConcurrent = 0;

    const tasks = Array.from({ length: 8 }, (_, i) => {
      return queue.enqueue(async () => {
        maxObservedConcurrent = Math.max(maxObservedConcurrent, queue.activeCount);
        assert.ok(queue.activeCount <= maxConcurrency, `Worker (${queue.activeCount}) melebihi maxConcurrency (${maxConcurrency})`);
        await new Promise((r) => setTimeout(r, 80));
        return i;
      }, { userId: `user_${i}` });
    });

    const results = await Promise.all(tasks);
    assert.strictEqual(results.length, 8);
    assert.strictEqual(maxObservedConcurrent, maxConcurrency);
    assert.strictEqual(queue.activeCount, 0);
    assert.strictEqual(queue.queueCount, 0);
  });

  // 4. Uji Batas Per-User Concurrency Limit
  await it('4. Per-User Limit: Mencegah 1 user memonopoli worker dan menjalankan fair-share scheduling', async () => {
    const queue = new JobQueue({ maxConcurrency: 4, perUserLimit: 1 });
    let userAActive = 0;
    let maxUserAActive = 0;

    // User A mengirim 3 tugas berturut-turut
    const userATasks = Array.from({ length: 3 }, () => {
      return queue.enqueue(async () => {
        userAActive++;
        maxUserAActive = Math.max(maxUserAActive, userAActive);
        await new Promise((r) => setTimeout(r, 60));
        userAActive--;
        return 'userA_done';
      }, { userId: 'user_spammer' });
    });

    // User B mengirim 1 tugas
    const userBTask = queue.enqueue(async () => {
      return 'userB_done';
    }, { userId: 'user_fair' });

    const [bRes, aRes] = await Promise.all([userBTask, Promise.all(userATasks)]);
    assert.strictEqual(bRes, 'userB_done');
    assert.strictEqual(maxUserAActive, 1, 'User A tidak boleh memiliki lebih dari 1 tugas berjalan bersamaan');
    assert.strictEqual(queue.activeCount, 0);
  });

  // 5. Uji Deduplikasi Job (Idempotent Job Key)
  await it('5. Deduplikasi: Request duplikat dengan jobKey identik tidak diproses dua kali', async () => {
    const queue = new JobQueue({ maxConcurrency: 2 });
    let executionTimes = 0;

    const taskFn = async () => {
      executionTimes++;
      await new Promise((r) => setTimeout(r, 100));
      return 'unique_result';
    };

    // User mengirim request yang sama 3 kali secara bersamaan
    const req1 = queue.enqueue(taskFn, { jobKey: 'url_https://example.com/video1' });
    const req2 = queue.enqueue(taskFn, { jobKey: 'url_https://example.com/video1' });
    const req3 = queue.enqueue(taskFn, { jobKey: 'url_https://example.com/video1' });

    const [res1, res2, res3] = await Promise.all([req1, req2, req3]);
    assert.strictEqual(res1, 'unique_result');
    assert.strictEqual(res2, 'unique_result');
    assert.strictEqual(res3, 'unique_result');
    assert.strictEqual(executionTimes, 1, 'Tugas dengan jobKey sama hanya boleh dieksekusi 1 kali');
  });

  // 6. Uji Timeout Handling & Pelepasan Slot
  await it('6. Timeout: Job yang stuck melebihi timeoutMs ditandai timeout dan worker slot segera dilepas', async () => {
    const queue = new JobQueue({ maxConcurrency: 1, defaultTimeoutMs: 150 });
    let cleanupCalled = false;

    let caughtError = null;
    try {
      await queue.enqueue(async () => {
        // Simulasi tugas stuck selamanya
        await new Promise((r) => setTimeout(r, 1000));
      }, {
        timeoutMs: 100,
        onCleanup: () => { cleanupCalled = true; }
      });
    } catch (e) {
      caughtError = e;
    }

    assert.ok(caughtError, 'Tugas seharusnya gagal dengan error timeout');
    assert.ok(caughtError.message.includes('TIMEOUT'), `Pesan error: ${caughtError.message}`);
    assert.strictEqual(cleanupCalled, true, 'Callback onCleanup harus terpanggil saat timeout');
    assert.strictEqual(queue.activeCount, 0, 'Worker slot harus sudah dilepas');
    assert.strictEqual(queue.stats.totalTimeout, 1);

    // Pastikan antrean berikutnya dapat langsung berjalan normal
    const nextResult = await queue.enqueue(async () => 'next_ok', { timeoutMs: 500 });
    assert.strictEqual(nextResult, 'next_ok');
  });

  // 7. Uji Retry Terbatas dengan Exponential Backoff untuk Transient Error
  await it('7. Retry Terbatas: Melakukan retry otomatis pada transient error dan berhenti pada percobaan maksimal', async () => {
    const queue = new JobQueue({ maxConcurrency: 2, defaultMaxRetries: 2 });
    let attempts = 0;

    let caught = null;
    try {
      await queue.enqueue(async () => {
        attempts++;
        if (attempts < 3) {
          // Transient error: network timeout
          throw new Error('ETIMEDOUT connection reset by peer');
        }
        return 'success_after_retry';
      }, { maxRetries: 2 });
    } catch (e) {
      caught = e;
    }

    assert.strictEqual(caught, null, 'Tugas seharusnya sukses pada attempt ke-3');
    assert.strictEqual(attempts, 3, 'Tugas seharusnya di-retry hingga 3 attempt');
    assert.strictEqual(queue.stats.totalRetries, 2);
    assert.strictEqual(queue.stats.totalSuccess, 1);
  });

  // 8. Uji Non-Transient Error Tidak Di-Retry (Hemat Resource)
  await it('8. Non-Transient Failure: Error permanen (404 / INVALID_URL) langsung gagal tanpa retry', async () => {
    const queue = new JobQueue({ maxConcurrency: 2, defaultMaxRetries: 3 });
    let attempts = 0;

    let caught = null;
    try {
      await queue.enqueue(async () => {
        attempts++;
        throw new Error('INVALID_URL: Link tidak valid');
      }, { maxRetries: 3 });
    } catch (e) {
      caught = e;
    }

    assert.ok(caught, 'Tugas harus melempar error');
    assert.strictEqual(attempts, 1, 'Error permanen hanya boleh dicoba 1 kali (tidak boleh di-retry)');
    assert.strictEqual(queue.stats.totalFailed, 1);
  });

  // 9. Uji Persistensi & Crash Recovery di SQLite
  await it('9. SQLite Persistence & Crash Recovery: Job menggantung akibat restart otomatis ditandai failed', () => {
    const db = userDb.getDb();
    const queue = new JobQueue({ maxConcurrency: 2 });
    queue.setDb(db);

    const testJobId = `job_crash_test_${Date.now()}`;
    db.prepare(`
      INSERT INTO job_queue_logs (id, job_key, type, user_id, status, attempts, created_at)
      VALUES (?, 'test_crash_key', 'download', '628123456', 'processing', 1, ?)
    `).run(testJobId, Date.now() - 5000);

    // Simulasikan restart sistem dengan memanggil recoverDanglingJobs
    queue.recoverDanglingJobs();

    const row = db.prepare('SELECT * FROM job_queue_logs WHERE id = ?').get(testJobId);
    assert.strictEqual(row.status, 'failed');
    assert.strictEqual(row.error, 'SYSTEM_RESTARTED');

    // Bersihkan data test
    db.prepare('DELETE FROM job_queue_logs WHERE id = ?').run(testJobId);
  });

  // 10. Uji getSmallestAvailableId SQLite Teroptimasi
  await it('10. Optimasi getSmallestAvailableId menemukan gap ID terkecil secara efisien', () => {
    const minId = userDb.getSmallestAvailableId();
    assert.ok(typeof minId === 'number' && minId >= 1, `minId harus angka >= 1 (didapat: ${minId})`);
  });

  console.log('\n====================================================');
  console.log(`📊 HASIL PENGUJIAN QUEUE: ${passedTests} LULUS, ${totalTests - passedTests} GAGAL`);
  console.log('====================================================\n');
}

runQueueTests().catch((e) => {
  console.error('Test suite failed:', e);
  process.exit(1);
});
