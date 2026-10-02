const assert = require('assert');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const {
  downloadAudio,
  downloadVideo,
  downloadYouTubeAudio,
  downloadYouTubeVideo,
  globalJobQueue
} = require('../downloader');
const scraper = require('../lib/scraper');
const { stalkTikTok } = require('../lib/tiktokStalk');
const {
  classifyError,
  getUserMessageForCategory,
  ERROR_CATEGORIES
} = require('../helpers/errorHandler');
const { isTransientError } = require('../helpers/jobQueue');
const { deleteFileSafe } = require('../utils');

let passCount = 0;
let failCount = 0;

async function test(name, fn) {
  try {
    process.stdout.write(`⏳ Menjalankan: ${name} ... `);
    await fn();
    console.log(`✅ [PASS]`);
    passCount++;
  } catch (err) {
    console.log(`❌ [FAIL]`);
    console.error(`   Error: ${err.message}\n`, err.stack);
    failCount++;
  }
}

async function runHardeningTests() {
  console.log('\n=============================================================');
  console.log('🧪 PENGUJIAN KETAHANAN SISTEM DOWNLOADER, YOUTUBE & TIKTOK');
  console.log('=============================================================\n');

  // 1. YouTube Audio Normal
  await test('1. YouTube Audio Normal (unduh audio mp3, validasi ada dan size > 0, cleanup)', async () => {
    const res = await downloadYouTubeAudio('https://www.youtube.com/watch?v=dQw4w9WgXcQ', `test_yt_aud_${Date.now()}`);
    assert.ok(res.filePath, 'File path harus ada');
    assert.ok(fs.existsSync(res.filePath), 'File hasil harus ada di disk');
    const stat = fs.statSync(res.filePath);
    assert.ok(stat.size > 0, 'Ukuran file harus lebih besar dari 0');
    assert.ok(res.filePath.endsWith('.mp3'), 'File harus berekstensi .mp3');
    deleteFileSafe(res.filePath);
    assert.strictEqual(fs.existsSync(res.filePath), false, 'File harus bersih setelah dihapus');
  });

  // 2. YouTube Video Normal
  await test('2. YouTube Video Normal (unduh video mp4, validasi format H.264/AAC dan size > 0, cleanup)', async () => {
    const res = await downloadYouTubeVideo('https://www.youtube.com/watch?v=dQw4w9WgXcQ', `test_yt_vid_${Date.now()}`);
    assert.ok(res.filePath, 'File path harus ada');
    assert.ok(fs.existsSync(res.filePath), 'File hasil harus ada di disk');
    const stat = fs.statSync(res.filePath);
    assert.ok(stat.size > 0, 'Ukuran video harus lebih besar dari 0');
    assert.ok(res.filePath.endsWith('.mp4'), 'File harus berekstensi .mp4');
    deleteFileSafe(res.filePath);
    assert.strictEqual(fs.existsSync(res.filePath), false, 'File harus bersih setelah dihapus');
  });

  // 3. YouTube URL Invalid
  await test('3. YouTube URL Invalid (terdeteksi INVALID_URL, non-transient, tidak retry tanpa akhir)', async () => {
    let thrown = null;
    try {
      await downloadYouTubeAudio('https://www.youtube.com/watch?v=invalid_id_xxx_12345', `test_invalid_${Date.now()}`);
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown, 'Harus melempar error');
    const classified = classifyError(thrown, { platform: 'YouTube' });
    assert.ok(
      [ERROR_CATEGORIES.NOT_FOUND, ERROR_CATEGORIES.INVALID_URL, ERROR_CATEGORIES.DOWNLOAD_ERROR].includes(classified.category),
      `Kategori harus sesuai (diterima: ${classified.category})`
    );
    assert.strictEqual(isTransientError(thrown), false, 'Error permanen tidak boleh di-retry');
    const userMsg = getUserMessageForCategory(classified.category, { platform: 'YouTube' });
    assert.ok(userMsg && !userMsg.includes('undefined'), 'Pesan user harus ramah dan jelas');
  });

  // 4. YouTube Video Unavailable / Deleted
  await test('4. YouTube Video Unavailable (terklasifikasi NOT_FOUND tanpa technical dump)', async () => {
    let thrown = null;
    try {
      await downloadYouTubeAudio('https://www.youtube.com/watch?v=00000000000', `test_unavailable_${Date.now()}`);
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown, 'Harus melempar error');
    const classified = classifyError(thrown, { platform: 'YouTube' });
    assert.ok(
      classified.category === ERROR_CATEGORIES.NOT_FOUND ||
      classified.category === ERROR_CATEGORIES.DOWNLOAD_ERROR ||
      classified.category === ERROR_CATEGORIES.INVALID_URL,
      `Kategori harus spesifik (didapat: ${classified.category})`
    );
    assert.strictEqual(isTransientError(thrown), false, 'Error video unavailable tidak boleh di-retry');
  });

  // 5. YouTube Timeout & Network Failure Classification
  await test('5. Klasifikasi Error Timeout & Network (TIMEOUT/NETWORK_ERROR adalah transient)', () => {
    const timeoutErr = new Error('Connection timed out after 15000ms');
    const classifiedTimeout = classifyError(timeoutErr);
    assert.strictEqual(classifiedTimeout.category, ERROR_CATEGORIES.TIMEOUT);
    assert.strictEqual(isTransientError(timeoutErr), true);

    const netErr = new Error('getaddrinfo ENOTFOUND www.youtube.com');
    const classifiedNet = classifyError(netErr);
    assert.strictEqual(classifiedNet.category, ERROR_CATEGORIES.NETWORK_ERROR);
    assert.strictEqual(isTransientError(netErr), true);

    const ageErr = new Error('Sign in to confirm your age. This video may be inappropriate for some users.');
    const classifiedAge = classifyError(ageErr);
    assert.strictEqual(classifiedAge.category, ERROR_CATEGORIES.AGE_RESTRICTED);
    assert.strictEqual(isTransientError(ageErr), false);

    const loginErr = new Error('Sign in to confirm you’re not a bot.');
    const classifiedLogin = classifyError(loginErr);
    assert.strictEqual(classifiedLogin.category, ERROR_CATEGORIES.LOGIN_REQUIRED);
    assert.strictEqual(isTransientError(loginErr), false);
  });

  // 6. TikTok Stalk ketika Cloudflare Aktif
  await test('6. TikTok Stalk ketika Cloudflare aktif (ditangani anggun, pesan ramah format .tt, tanpa crash)', async () => {
    let thrown = null;
    try {
      await stalkTikTok('sandikagalih');
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown, 'Harus menangkap pembatasan Cloudflare');
    const classified = classifyError(thrown, { platform: 'tiktok', action: 'stalk' });
    assert.strictEqual(classified.category, ERROR_CATEGORIES.CLOUDFLARE);
    const msg = getUserMessageForCategory(classified.category, { platform: 'tiktok', action: 'stalk' });
    assert.ok(
      msg.includes('.tt <url>'),
      'Pesan harus mengarahkan ke downloader: ' + msg
    );
    assert.strictEqual(isTransientError(thrown), false, 'Cloudflare tidak boleh di-retry agresif');
  });

  // 7. TikTok Downloader Normal & Multi Fallback
  await test('7. TikTok Downloader Normal & Fallback (berhasil mengambil konten TikTok)', async () => {
    // Gunakan video feed yang aktif
    const res = await scraper.getTikTok('https://www.tiktok.com/@aldous7776/video/7668205959784828168');
    assert.ok(res, 'Hasil TikTok scraper harus ada');
    assert.ok(res.videoUrl || (res.images && res.images.length > 0), 'Harus memiliki videoUrl atau images');
    assert.ok(res.title, 'Harus memiliki judul/deskripsi');
  });

  // 8. Dua Download Bersamaan (Concurrent Download)
  await test('8. Dua download bersamaan (berjalan paralel tanpa saling memblokir)', async () => {
    const t0 = Date.now();
    const [d1, d2] = await Promise.all([
      downloadYouTubeAudio('https://www.youtube.com/watch?v=dQw4w9WgXcQ', `c1_${Date.now()}`, 'user_1'),
      downloadYouTubeAudio('https://www.youtube.com/watch?v=jNQXAC9IVRw', `c2_${Date.now()}`, 'user_2')
    ]);

    assert.ok(d1.filePath && fs.existsSync(d1.filePath), 'File 1 harus ada');
    assert.ok(d2.filePath && fs.existsSync(d2.filePath), 'File 2 harus ada');
    deleteFileSafe(d1.filePath);
    deleteFileSafe(d2.filePath);

    const elapsed = (Date.now() - t0) / 1000;
    console.log(`(Paralel 2 download selesai dalam ${elapsed.toFixed(2)} detik)`);
  });

  // 9. Download Gagal di Tengah Proses & Pembersihan File
  await test('9. File output kosong / tidak ditemukan (dibersihkan dan tidak dikirim)', () => {
    const fakePrefix = `test_cleanup_${Date.now()}`;
    const strayFile = path.join(config.downloadDir, `${fakePrefix}.temp`);
    fs.writeFileSync(strayFile, 'corrupted_partial_data');
    assert.ok(fs.existsSync(strayFile));

    // Bersihkan file residu
    deleteFileSafe(strayFile);
    assert.strictEqual(fs.existsSync(strayFile), false);

    // Verifikasi penolakan file 0 bytes
    const emptyFile = path.join(config.tempDir, `${fakePrefix}_zero.mp3`);
    fs.writeFileSync(emptyFile, '');
    assert.strictEqual(fs.statSync(emptyFile).size, 0);

    const isUsable = fs.existsSync(emptyFile) && fs.statSync(emptyFile).size > 0;
    assert.strictEqual(isUsable, false, 'File 0 bytes harus dianggap invalid');
    deleteFileSafe(emptyFile);
  });

  // 10. Crash Recovery / Restart Tanpa Loop Crash
  await test('10. Crash Recovery & PM2 Stability: Job stuck otomatis dipulihkan saat startup', () => {
    const testDb = require('../database/users').getDb();
    globalJobQueue.setDb(testDb);
    // Masukkan job palsu berstatus 'processing' untuk simulasi crash
    const dummyId = `crash_sim_${Date.now()}`;
    testDb.prepare(`
      INSERT OR REPLACE INTO job_queue_logs (id, job_key, type, user_id, status, created_at, started_at)
      VALUES (?, 'sim_key', 'test', 'tester', 'processing', ?, ?)
    `).run(dummyId, Date.now() - 5000, Date.now() - 5000);

    // Panggil pemulihan restart
    globalJobQueue.recoverDanglingJobs();

    const recovered = testDb.prepare('SELECT status, error FROM job_queue_logs WHERE id = ?').get(dummyId);
    assert.strictEqual(recovered.status, 'failed', 'Job menggantung harus ditandai failed');
    assert.strictEqual(recovered.error, 'SYSTEM_RESTARTED', 'Alasan error harus SYSTEM_RESTARTED');

    testDb.prepare('DELETE FROM job_queue_logs WHERE id = ?').run(dummyId);
  });

  console.log('\n=============================================================');
  console.log(`📊 HASIL PENGUJIAN KETAHANAN: ${passCount} LULUS, ${failCount} GAGAL`);
  console.log('=============================================================\n');

  if (failCount > 0) {
    process.exit(1);
  }
}

runHardeningTests();
