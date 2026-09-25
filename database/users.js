const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');
const { normalizeUserNumber, isValidUserNumber } = require('../helpers/userHelper');

// Path database SQLite
const dbDir = path.join(__dirname);
const sqlitePath = path.join(dbDir, 'bot.sqlite');

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

let dbInstance = null;

function getDb() {
  if (!dbInstance) {
    dbInstance = new Database(sqlitePath);
    dbInstance.pragma('journal_mode = WAL');
    initTables();
  }
  return dbInstance;
}

function initTables() {
  const db = dbInstance;
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT UNIQUE NOT NULL,
      phone TEXT,
      name TEXT,
      registered INTEGER DEFAULT 0,
      created_at INTEGER,
      updated_at INTEGER,
      usage_count INTEGER DEFAULT 0,
      limit_type TEXT DEFAULT 'limited',
      is_admin INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_users_jid ON users(jid);
    CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);

    CREATE TABLE IF NOT EXISTS command_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER,
      user_id TEXT,
      number TEXT,
      username TEXT,
      command TEXT,
      arguments TEXT,
      chat_type TEXT,
      chat_id TEXT,
      group_name TEXT,
      status TEXT,
      execution_time REAL,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON command_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_logs_command ON command_logs(command);
    CREATE INDEX IF NOT EXISTS idx_logs_number ON command_logs(number);

    CREATE TABLE IF NOT EXISTS guest_limits (
      phone TEXT PRIMARY KEY,
      jid TEXT,
      usage_count INTEGER DEFAULT 0,
      total_commands INTEGER DEFAULT 0,
      success_commands INTEGER DEFAULT 0,
      failed_commands INTEGER DEFAULT 0,
      last_command TEXT DEFAULT '',
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS lid_mappings (
      lid TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      updated_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_lid_phone ON lid_mappings(phone);
  `);

  // Pastikan kolom-kolom baru tersedia pada tabel users
  try {
    const tableInfo = db.pragma('table_info(users)');
    const colNames = tableInfo.map((c) => c.name);

    if (!colNames.includes('kota')) {
      db.exec("ALTER TABLE users ADD COLUMN kota TEXT DEFAULT '';");
    }
    if (!colNames.includes('umur')) {
      db.exec('ALTER TABLE users ADD COLUMN umur INTEGER DEFAULT 0;');
    }
    if (!colNames.includes('status')) {
      db.exec("ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'Aktif';");
    }
    if (!colNames.includes('registered_at')) {
      db.exec('ALTER TABLE users ADD COLUMN registered_at INTEGER DEFAULT 0;');
    }
    if (!colNames.includes('limit_val')) {
      db.exec('ALTER TABLE users ADD COLUMN limit_val INTEGER DEFAULT 50;');
    }
    if (!colNames.includes('is_admin')) {
      db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0;');
    }
    if (!colNames.includes('role')) {
      db.exec("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'User';");
    }
    if (!colNames.includes('premium')) {
      db.exec('ALTER TABLE users ADD COLUMN premium INTEGER DEFAULT 0;');
    }
    if (!colNames.includes('unlimited')) {
      db.exec('ALTER TABLE users ADD COLUMN unlimited INTEGER DEFAULT 0;');
    }
    if (!colNames.includes('total_commands')) {
      db.exec('ALTER TABLE users ADD COLUMN total_commands INTEGER DEFAULT 0;');
    }
    if (!colNames.includes('success_commands')) {
      db.exec('ALTER TABLE users ADD COLUMN success_commands INTEGER DEFAULT 0;');
    }
    if (!colNames.includes('failed_commands')) {
      db.exec('ALTER TABLE users ADD COLUMN failed_commands INTEGER DEFAULT 0;');
    }
    if (!colNames.includes('last_command')) {
      db.exec("ALTER TABLE users ADD COLUMN last_command TEXT DEFAULT '';");
    }
    if (!colNames.includes('banned')) {
      db.exec('ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0;');
    }
    if (!colNames.includes('hits_today')) {
      db.exec('ALTER TABLE users ADD COLUMN hits_today INTEGER DEFAULT 0;');
    }
    if (!colNames.includes('last_reset_date')) {
      db.exec("ALTER TABLE users ADD COLUMN last_reset_date TEXT DEFAULT '';");
    }
    if (!colNames.includes('premium_package')) {
      db.exec("ALTER TABLE users ADD COLUMN premium_package TEXT DEFAULT '';");
    }
    if (!colNames.includes('premium_started_at')) {
      db.exec('ALTER TABLE users ADD COLUMN premium_started_at INTEGER DEFAULT 0;');
    }
    if (!colNames.includes('premium_expires_at')) {
      db.exec('ALTER TABLE users ADD COLUMN premium_expires_at INTEGER DEFAULT 0;');
    }

    const guestTableInfo = db.pragma('table_info(guest_limits)');
    const guestColNames = guestTableInfo.map((c) => c.name);
    if (!guestColNames.includes('hits_today')) {
      db.exec('ALTER TABLE guest_limits ADD COLUMN hits_today INTEGER DEFAULT 0;');
    }
    if (!guestColNames.includes('last_reset_date')) {
      db.exec("ALTER TABLE guest_limits ADD COLUMN last_reset_date TEXT DEFAULT '';");
    }
  } catch (_) {}

  // Migrasi guest lama (registered = 0) ke guest_limits dan bersihkan dari tabel users
  try {
    db.exec(`
      INSERT OR IGNORE INTO guest_limits (phone, jid, usage_count, updated_at)
      SELECT phone, jid, usage_count, updated_at FROM users WHERE registered = 0 AND phone IS NOT NULL;
      DELETE FROM users WHERE registered = 0;
    `);

    // Bersihkan identifier non-nomor/LID dari guest_limits dan users jika ada
    const allGuests = db.prepare('SELECT phone FROM guest_limits').all();
    for (const g of allGuests) {
      if (!isValidUserNumber(g.phone)) {
        db.prepare('DELETE FROM guest_limits WHERE phone = ?').run(g.phone);
      }
    }
    const allUsers = db.prepare('SELECT id, phone FROM users').all();
    for (const u of allUsers) {
      if (u.phone && !isValidUserNumber(u.phone)) {
        db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
      }
    }
  } catch (_) {}

  // Pastikan Owner (6282267034994) selalu terdaftar sebagai User ID 1
  try {
    const ownerNum = config.owner.number.replace(/[^0-9]/g, '');
    const ownerJid = `${ownerNum}@s.whatsapp.net`;
    const ownerUser = db.prepare('SELECT id FROM users WHERE phone = ? OR jid = ?').get(ownerNum, ownerJid);
    const now = Date.now();
    if (!ownerUser) {
      db.prepare(`
        INSERT OR REPLACE INTO users (id, phone, jid, name, kota, umur, registered, registered_at, status, limit_val, limit_type, role, unlimited, created_at, updated_at)
        VALUES (1, ?, ?, ?, 'Lhokseumawe', 20, 1, ?, 'Aktif', 50, 'unlimited', 'owner', 1, ?, ?)
      `).run(ownerNum, ownerJid, config.owner.name, now, now, now);
    } else if (ownerUser.id !== 1) {
      const id1User = db.prepare('SELECT id FROM users WHERE id = 1').get();
      if (!id1User) {
        db.prepare("UPDATE users SET id = 1, registered = 1, role = 'owner', unlimited = 1, status = 'Aktif', kota = 'Lhokseumawe', umur = 20 WHERE id = ?").run(ownerUser.id);
      }
    }
  } catch (_) {}

  // Migrasi otomatis data dari database.json jika tabel masih baru/kosong
  try {
    const countRow = db.prepare('SELECT COUNT(*) as count FROM users').get();
    if (countRow.count === 0 && fs.existsSync(config.databasePath)) {
      const raw = fs.readFileSync(config.databasePath, 'utf8');
      const jsonData = JSON.parse(raw);
      if (jsonData && jsonData.users) {
        const insertStmt = db.prepare(`
          INSERT OR IGNORE INTO users (jid, phone, name, registered, created_at, updated_at, usage_count, limit_type)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const now = Date.now();
        const transaction = db.transaction((usersObj) => {
          for (const [phoneKey, u] of Object.entries(usersObj)) {
            const cleanPhone = phoneKey.replace(/[^0-9]/g, '');
            if (!cleanPhone) continue;
            const jid = `${cleanPhone}@s.whatsapp.net`;
            const registered = u.name ? 1 : 0;
            const limitType = registered ? 'unlimited' : 'limited';
            insertStmt.run(
              jid,
              cleanPhone,
              u.name || '',
              registered,
              u.registeredAt || now,
              now,
              0,
              limitType
            );
          }
        });
        transaction(jsonData.users);
      }
    }
  } catch (err) {
    console.error('[DB-SQLite] Gagal migrasi data awal:', err.message);
  }
}

function extractPhone(rawJid) {
  if (!rawJid) return '';
  if (typeof rawJid === 'string' && rawJid.includes('@lid')) {
    const fromLid = getPhoneByLid(rawJid);
    if (fromLid) return fromLid;
  }
  const normalized = normalizeUserNumber(rawJid);
  if (!normalized || !isValidUserNumber(normalized)) return '';
  return normalized;
}

/**
 * Simpan pemetaan LID ke Nomor WhatsApp asli ke database
 */
function saveLidMapping(lid, phone) {
  if (!lid || !phone) return;
  const cleanLid = String(lid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
  const cleanPhone = extractPhone(phone) || String(phone).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
  if (!cleanLid || !cleanPhone || !isValidUserNumber(cleanPhone)) return;

  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO lid_mappings (lid, phone, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(lid) DO UPDATE SET phone = excluded.phone, updated_at = excluded.updated_at
    `).run(cleanLid, cleanPhone, Date.now());
  } catch (_) {}
}

/**
 * Cari nomor WhatsApp asli berdasarkan LID dari database
 */
function getPhoneByLid(lid) {
  if (!lid) return null;
  const cleanLid = String(lid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
  if (!cleanLid) return null;

  try {
    const db = getDb();
    const row = db.prepare('SELECT phone FROM lid_mappings WHERE lid = ?').get(cleanLid);
    return row ? row.phone : null;
  } catch (_) {
    return null;
  }
}

/**
 * Cari LID WhatsApp berdasarkan nomor HP dari database
 */
function getLidByPhone(phone) {
  if (!phone) return null;
  const cleanPhone = extractPhone(phone) || String(phone).replace(/[^0-9]/g, '');
  if (!cleanPhone) return null;
  try {
    const db = getDb();
    const row = db.prepare('SELECT lid FROM lid_mappings WHERE phone = ? ORDER BY updated_at DESC LIMIT 1').get(cleanPhone);
    return row ? row.lid : null;
  } catch (_) {
    return null;
  }
}

/**
 * Normalisasi JID agar format seragam
 */
function normalizeUserJid(rawJid) {
  const phone = extractPhone(rawJid);
  return phone ? `${phone}@s.whatsapp.net` : '';
}

/**
 * Cek apakah nomor merupakan salah satu nomor Owner terdaftar
 */
function isOwnerPhone(phone) {
  const clean = extractPhone(phone);
  const ownerNum = config.owner.number.replace(/[^0-9]/g, '');
  if (clean === ownerNum) return true;
  if (Array.isArray(config.owner.numbers)) {
    return config.owner.numbers.some((n) => n.replace(/[^0-9]/g, '') === clean);
  }
  return false;
}

/**
 * Mencari ID kosong terkecil mulai dari 1 (smallest available ID / first available ID)
 */
function getSmallestAvailableId() {
  const db = getDb();
  const rows = db.prepare('SELECT id FROM users ORDER BY id ASC').all();
  let candidate = 1;
  for (const row of rows) {
    if (row.id === candidate) {
      candidate++;
    } else if (row.id > candidate) {
      return candidate;
    }
  }
  return candidate;
}

/**
 * Mendapatkan string tanggal hari ini dalam format YYYY-MM-DD (Zona Waktu WIB / Asia/Jakarta)
 */
function getTodayDateString() {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());
  } catch (_) {
    const d = new Date(Date.now() + 7 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
  }
}

/**
 * Menghitung sisa waktu menuju pukul 00:00:00 WIB (tengah malam)
 * @returns {string} Contoh: "2 jam 15 menit"
 */
function getTimeUntilMidnightWib() {
  try {
    const now = new Date();
    const nowWib = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
    const midnight = new Date(nowWib);
    midnight.setHours(24, 0, 0, 0);

    const diffMs = Math.max(0, midnight.getTime() - nowWib.getTime());
    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

    if (hours === 0 && minutes === 0) {
      const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);
      return `${seconds} detik`;
    }
    return `${hours} jam ${minutes} menit`;
  } catch (_) {
    return 'beberapa jam ke depan';
  }
}

/**
 * Helper format tanggal Indonesia (misal: 25 September 2026)
 */
function formatIndonesianDate(timestamp) {
  if (!timestamp) return '-';
  const d = new Date(timestamp);
  const months = [
    'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
    'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
  ];
  const day = d.getDate();
  const month = months[d.getMonth()];
  const year = d.getFullYear();
  return `${day} ${month} ${year}`;
}

/**
 * Ambil data user dari database.
 * Jika terdaftar: mengembalikan data user + ID unik.
 * Jika belum terdaftar: mengembalikan status guest dengan limit default 10 hit/hari.
 */
function getUser(rawJid, pushName = '') {
  const db = getDb();
  const jid = normalizeUserJid(rawJid);
  const phone = extractPhone(rawJid);
  if (!phone) return null;

  const todayStr = getTodayDateString();

  // 1. Cari di tabel users (terdaftar)
  let user = db.prepare('SELECT * FROM users WHERE phone = ? OR jid = ?').get(phone, jid);

  const isOwner = isOwnerPhone(phone) || (user && isOwnerPhone(user.phone));

  // Jika owner belum tercatat di users, inisialisasi sebagai ID 1
  if (isOwner && !user) {
    const id = getSmallestAvailableId();
    const now = Date.now();
    db.prepare(`
      INSERT OR REPLACE INTO users (id, phone, jid, name, kota, umur, registered, registered_at, status, limit_val, limit_type, role, unlimited, premium, hits_today, last_reset_date, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'Lhokseumawe', 20, 1, ?, 'Aktif', 30, 'unlimited', 'owner', 1, 1, 0, ?, ?, ?)
    `).run(id, phone, jid, config.owner.name, now, todayStr, now, now);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    return user;
  }

  if (user) {
    const now = Date.now();

    // A. Cek apakah masa aktif Premium sudah kedaluwarsa
    if (user.premium === 1 && user.premium_expires_at > 0 && now > user.premium_expires_at && !isOwner) {
      db.prepare(`
        UPDATE users
        SET premium = 0, premium_package = '', limit_type = 'limited', unlimited = 0,
            role = CASE WHEN role = 'Premium' THEN 'User' ELSE role END, updated_at = ?
        WHERE id = ?
      `).run(now, user.id);
      user.premium = 0;
      user.premium_package = '';
      user.limit_type = 'limited';
      user.unlimited = 0;
      if (user.role === 'Premium') user.role = 'User';
    }

    // B. Cek reset hit harian (Pukul 00:00 WIB)
    if (user.last_reset_date !== todayStr) {
      db.prepare('UPDATE users SET hits_today = 0, last_reset_date = ? WHERE id = ?').run(todayStr, user.id);
      user.hits_today = 0;
      user.last_reset_date = todayStr;
    }

    if (isOwner && user.role !== 'owner') {
      user.role = 'owner';
      user.limit_type = 'unlimited';
      user.unlimited = 1;
      db.prepare("UPDATE users SET role = 'owner', limit_type = 'unlimited', unlimited = 1, registered = 1 WHERE id = ?").run(user.id);
    }
    if (pushName && !user.name) {
      db.prepare('UPDATE users SET name = ?, updated_at = ? WHERE id = ?').run(pushName, Date.now(), user.id);
      user.name = pushName;
    }

    user.limit_val = (user.unlimited === 1 || user.premium === 1 || isOwner) ? Infinity : 30;
    return user;
  }

  // 2. User belum terdaftar (Guest)
  let guest = db.prepare('SELECT * FROM guest_limits WHERE phone = ?').get(phone);
  const now = Date.now();
  if (!guest) {
    db.prepare('INSERT OR IGNORE INTO guest_limits (phone, jid, usage_count, hits_today, last_reset_date, updated_at) VALUES (?, ?, 0, 0, ?, ?)').run(phone, jid, todayStr, now);
    guest = { phone, jid, usage_count: 0, hits_today: 0, last_reset_date: todayStr, updated_at: now };
  } else if (guest.last_reset_date !== todayStr) {
    db.prepare('UPDATE guest_limits SET hits_today = 0, last_reset_date = ? WHERE phone = ?').run(todayStr, phone);
    guest.hits_today = 0;
    guest.last_reset_date = todayStr;
  }

  return {
    id: null,
    jid,
    phone,
    name: pushName || 'User',
    kota: '',
    umur: 0,
    registered: 0,
    registered_at: 0,
    status: 'Belum Terdaftar',
    limit_type: 'limited',
    limit_val: 10,
    usage_count: guest.usage_count || 0,
    hits_today: guest.hits_today || 0,
    last_reset_date: guest.last_reset_date || todayStr,
    role: 'User',
    premium: 0,
    premium_package: '',
    premium_started_at: 0,
    premium_expires_at: 0,
    unlimited: 0,
    total_commands: guest.total_commands || 0,
    success_commands: guest.success_commands || 0,
    failed_commands: guest.failed_commands || 0,
    last_command: guest.last_command || '',
    banned: 0,
    is_admin: 0
  };
}

/**
 * Pendaftaran user baru dengan detail lengkap: Nama, Kota, Umur
 * Menggunakan ID kosong terkecil (smallest available ID) mulai dari 1.
 * Kuota user terdaftar adalah 30 hit/hari.
 */
function registerUserWithDetails(rawPhoneOrJid, details = {}) {
  const db = getDb();
  const phone = extractPhone(rawPhoneOrJid);
  const jid = normalizeUserJid(rawPhoneOrJid);
  if (!phone) return null;

  const todayStr = getTodayDateString();

  // Cek apakah sudah terdaftar
  let existing = db.prepare('SELECT * FROM users WHERE phone = ? OR jid = ?').get(phone, jid);
  if (existing && existing.registered === 1) {
    return existing;
  }

  const isOwner = isOwnerPhone(phone);
  const now = Date.now();
  const name = String(details.name || (isOwner ? config.owner.name : 'User')).trim();
  const kota = String(details.kota || '-').trim();
  const umur = parseInt(details.umur, 10) || 0;
  const isPrem = existing ? (existing.premium === 1 && (!existing.premium_expires_at || existing.premium_expires_at > now)) : false;

  const role = isOwner ? 'owner' : (isPrem ? 'Premium' : 'User');
  const limitType = (isOwner || isPrem) ? 'unlimited' : 'limited';
  const unlimited = (isOwner || isPrem) ? 1 : 0;
  const limitVal = (isOwner || isPrem) ? Infinity : 30; // 30 hit/hari untuk registered

  // Ambil hits_today dan usage_count sebelumnya dari guest_limits jika ada
  const guest = db.prepare('SELECT usage_count, hits_today, last_reset_date FROM guest_limits WHERE phone = ?').get(phone);
  const usageCount = guest ? (guest.usage_count || 0) : (existing ? (existing.usage_count || 0) : 0);
  const hitsToday = (guest && guest.last_reset_date === todayStr) ? (guest.hits_today || 0) : (existing && existing.last_reset_date === todayStr ? (existing.hits_today || 0) : 0);

  let assignedId;
  if (existing) {
    assignedId = (existing.id && existing.id > 0) ? existing.id : getSmallestAvailableId();
    db.prepare(`
      UPDATE users
      SET id = ?, name = ?, kota = ?, umur = ?, registered = 1, registered_at = ?,
          status = 'Aktif', limit_val = ?, limit_type = ?, role = ?, unlimited = ?,
          usage_count = ?, hits_today = ?, last_reset_date = ?, updated_at = ?
      WHERE phone = ? OR jid = ?
    `).run(assignedId, name, kota, umur, now, limitVal, limitType, role, unlimited, usageCount, hitsToday, todayStr, now, phone, jid);
  } else {
    assignedId = getSmallestAvailableId();
    db.prepare(`
      INSERT INTO users (id, phone, jid, name, kota, umur, registered, registered_at, status, limit_val, limit_type, role, unlimited, usage_count, hits_today, last_reset_date, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'Aktif', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(assignedId, phone, jid, name, kota, umur, now, limitVal, limitType, role, unlimited, usageCount, hitsToday, todayStr, now, now);
  }

  // Bersihkan dari guest_limits
  try {
    db.prepare('DELETE FROM guest_limits WHERE phone = ?').run(phone);
  } catch (_) {}

  return db.prepare('SELECT * FROM users WHERE id = ?').get(assignedId);
}

/**
 * Mendaftarkan user (kompatibilitas nama saja)
 */
function registerUser(rawPhoneOrJid, fullName) {
  return registerUserWithDetails(rawPhoneOrJid, { name: fullName });
}

/**
 * Mengambil data user berdasarkan ID database numerik
 */
function getUserById(id) {
  const db = getDb();
  const numId = parseInt(id, 10);
  if (isNaN(numId)) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').get(numId);
}

/**
 * Mengambil semua user yang sudah terdaftar, urut ID ASC
 */
function getAllRegisteredUsers() {
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE registered = 1 ORDER BY id ASC').all();
}

/**
 * Menghapus user berdasarkan ID database numerik
 */
function deleteUserById(id) {
  const db = getDb();
  const numId = parseInt(id, 10);
  if (isNaN(numId)) return false;
  const res = db.prepare('DELETE FROM users WHERE id = ?').run(numId);
  return res.changes > 0;
}

/**
 * Menambah penggunaan limit (increment usage) harian dan total
 */
function incrementUsage(rawPhoneOrJid, amount = 1) {
  const db = getDb();
  const phone = extractPhone(rawPhoneOrJid);
  const jid = normalizeUserJid(rawPhoneOrJid);
  const now = Date.now();
  const todayStr = getTodayDateString();

  const user = db.prepare('SELECT id, hits_today, last_reset_date FROM users WHERE phone = ? OR jid = ?').get(phone, jid);
  if (user) {
    const hitsToday = (user.last_reset_date === todayStr) ? (user.hits_today || 0) + amount : amount;
    db.prepare(`
      UPDATE users
      SET usage_count = usage_count + ?, hits_today = ?, last_reset_date = ?, updated_at = ?
      WHERE id = ?
    `).run(amount, hitsToday, todayStr, now, user.id);
  } else {
    const guest = db.prepare('SELECT phone, hits_today, last_reset_date FROM guest_limits WHERE phone = ?').get(phone);
    const hitsToday = (guest && guest.last_reset_date === todayStr) ? (guest.hits_today || 0) + amount : amount;
    db.prepare(`
      INSERT INTO guest_limits (phone, jid, usage_count, hits_today, last_reset_date, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET
        usage_count = usage_count + excluded.usage_count,
        hits_today = excluded.hits_today,
        last_reset_date = excluded.last_reset_date,
        updated_at = excluded.updated_at
    `).run(phone, jid, amount, hitsToday, todayStr, now);
  }
}

/**
 * Reset limit penggunaan harian & total ke 0
 */
function resetLimit(rawPhoneOrJid) {
  const db = getDb();
  const phone = extractPhone(rawPhoneOrJid);
  const jid = normalizeUserJid(rawPhoneOrJid);
  const now = Date.now();
  const todayStr = getTodayDateString();

  const user = db.prepare('SELECT id FROM users WHERE phone = ? OR jid = ?').get(phone, jid);
  if (user) {
    db.prepare('UPDATE users SET usage_count = 0, hits_today = 0, last_reset_date = ?, updated_at = ? WHERE id = ?').run(todayStr, now, user.id);
  }
  db.prepare('UPDATE guest_limits SET usage_count = 0, hits_today = 0, last_reset_date = ?, updated_at = ? WHERE phone = ?').run(todayStr, now, phone);
  return true;
}

/**
 * Mengubah status user menjadi Unlimited
 */
function setUnlimited(rawPhoneOrJid) {
  const db = getDb();
  const phone = extractPhone(rawPhoneOrJid);
  const jid = normalizeUserJid(rawPhoneOrJid);
  const now = Date.now();

  // Pastikan user ada
  getUser(jid);

  const res = db.prepare(`
    UPDATE users
    SET limit_type = 'unlimited', unlimited = 1, updated_at = ?
    WHERE jid = ? OR phone = ?
  `).run(now, jid, phone);

  return res.changes > 0;
}

/**
 * Mengubah status user menjadi Limited
 */
function setLimit(rawPhoneOrJid) {
  const db = getDb();
  const phone = extractPhone(rawPhoneOrJid);
  const jid = normalizeUserJid(rawPhoneOrJid);
  const now = Date.now();
  const todayStr = getTodayDateString();

  // Pastikan user ada
  getUser(jid);

  const res = db.prepare(`
    UPDATE users
    SET limit_type = 'limited', unlimited = 0, premium = 0, premium_package = '',
        usage_count = 0, hits_today = 0, last_reset_date = ?, updated_at = ?
    WHERE jid = ? OR phone = ?
  `).run(todayStr, now, jid, phone);

  db.prepare(`
    UPDATE guest_limits
    SET usage_count = 0, hits_today = 0, last_reset_date = ?, updated_at = ?
    WHERE phone = ?
  `).run(todayStr, now, phone);

  return res.changes > 0;
}

/**
 * Tambah user ke status Premium
 * @param {string} rawPhoneOrJid Nomor atau JID user
 * @param {string} [packageType='30 Hari'] Nama paket (misal: '7 Hari', '30 Hari')
 * @param {number} [durationDays=30] Lama durasi dalam hari (7 atau 30)
 * @returns {object|null}
 */
function addPremium(rawPhoneOrJid, packageType = '30 Hari', durationDays = 30) {
  const db = getDb();
  const phone = extractPhone(rawPhoneOrJid);
  const jid = normalizeUserJid(rawPhoneOrJid);
  if (!phone) return null;

  let user = getUser(jid);
  const now = Date.now();
  const days = parseInt(durationDays, 10) || 30;
  const durationMs = days * 24 * 60 * 60 * 1000;
  // Perpanjang jika sebelumnya masih aktif
  const baseTime = (user && user.premium === 1 && user.premium_expires_at > now)
    ? user.premium_expires_at
    : now;
  const expiresAt = baseTime + durationMs;
  const pkgName = String(packageType || (days === 7 ? '7 Hari' : '30 Hari'));

  if (user && user.id) {
    db.prepare(`
      UPDATE users
      SET premium = 1, premium_package = ?, premium_started_at = ?, premium_expires_at = ?,
          limit_type = 'unlimited', unlimited = 1,
          role = CASE WHEN role = 'owner' OR is_admin = 1 THEN role ELSE 'Premium' END,
          updated_at = ?
      WHERE id = ?
    `).run(pkgName, now, expiresAt, now, user.id);
  } else {
    const id = getSmallestAvailableId();
    db.prepare(`
      INSERT INTO users (id, phone, jid, name, registered, registered_at, status, limit_val, limit_type, role, premium, premium_package, premium_started_at, premium_expires_at, unlimited, created_at, updated_at)
      VALUES (?, ?, ?, 'User Premium', 1, ?, 'Aktif', 30, 'unlimited', 'Premium', 1, ?, ?, ?, 1, ?, ?)
    `).run(id, phone, jid, now, pkgName, now, expiresAt, now, now);
  }

  return getUser(jid);
}

/**
 * Hapus status Premium user
 * @param {string} rawPhoneOrJid
 * @returns {object|null}
 */
function removePremium(rawPhoneOrJid) {
  const db = getDb();
  const phone = extractPhone(rawPhoneOrJid);
  const jid = normalizeUserJid(rawPhoneOrJid);
  if (!phone) return null;

  const now = Date.now();
  db.prepare(`
    UPDATE users
    SET premium = 0, premium_package = '', premium_started_at = 0, premium_expires_at = 0,
        limit_type = 'limited', unlimited = 0,
        role = CASE WHEN role = 'Premium' THEN 'User' ELSE role END,
        updated_at = ?
    WHERE phone = ? OR jid = ?
  `).run(now, phone, jid);

  return getUser(jid);
}

/**
 * Ambil daftar user Premium aktif
 */
function listPremiumUsers() {
  const db = getDb();
  const now = Date.now();
  const rows = db.prepare('SELECT * FROM users WHERE premium = 1 ORDER BY premium_expires_at ASC').all();
  return rows.map((u) => {
    const remainingMs = Math.max(0, (u.premium_expires_at || 0) - now);
    const remainingDays = Math.ceil(remainingMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor(remainingMs / (1000 * 60 * 60));
    return {
      ...u,
      remainingDays,
      remainingHours: hours,
      isExpired: remainingMs <= 0
    };
  });
}

/**
 * Ambil data user lengkap
 */
function getUserInfo(rawPhoneOrJid) {
  const db = getDb();
  const phone = extractPhone(rawPhoneOrJid);
  const jid = normalizeUserJid(rawPhoneOrJid);

  return db.prepare('SELECT * FROM users WHERE jid = ? OR phone = ?').get(jid, phone);
}

/**
 * Statistik jumlah user
 */
function getUsersStats() {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const registered = db.prepare('SELECT COUNT(*) as c FROM users WHERE registered = 1').get().c;
  const unlimited = db.prepare("SELECT COUNT(*) as c FROM users WHERE limit_type = 'unlimited'").get().c;
  const limited = db.prepare("SELECT COUNT(*) as c FROM users WHERE limit_type = 'limited'").get().c;

  return {
    total,
    registered,
    unlimited,
    limited
  };
}

/**
 * Cek apakah user adalah Admin Bot atau Owner
 */
function isBotAdmin(rawPhoneOrJid) {
  const phone = extractPhone(rawPhoneOrJid);
  const jid = normalizeUserJid(rawPhoneOrJid);

  if (isOwnerPhone(phone)) return true;

  const db = getDb();
  const user = db.prepare('SELECT is_admin FROM users WHERE jid = ? OR phone = ?').get(jid, phone);
  return Boolean(user && user.is_admin === 1);
}

/**
 * Menambahkan user menjadi Admin Bot
 */
function addBotAdmin(rawPhoneOrJid) {
  const db = getDb();
  const phone = extractPhone(rawPhoneOrJid);
  const jid = normalizeUserJid(rawPhoneOrJid);
  const now = Date.now();

  const existing = db.prepare('SELECT id FROM users WHERE phone = ? OR jid = ?').get(phone, jid);
  if (existing) {
    db.prepare(`
      UPDATE users 
      SET is_admin = 1, registered = 1, limit_type = 'unlimited', unlimited = 1, role = 'admin', updated_at = ?
      WHERE id = ?
    `).run(now, existing.id);
  } else {
    const id = getSmallestAvailableId();
    db.prepare(`
      INSERT INTO users (id, phone, jid, name, registered, registered_at, status, limit_val, limit_type, role, is_admin, unlimited, created_at, updated_at)
      VALUES (?, ?, ?, 'Admin Bot', 1, ?, 'Aktif', 30, 'unlimited', 'admin', 1, 1, ?, ?)
    `).run(id, phone, jid, now, now, now);
  }

  return true;
}

/**
 * Menghapus user dari Admin Bot
 */
function removeBotAdmin(rawPhoneOrJid) {
  const db = getDb();
  const phone = extractPhone(rawPhoneOrJid);
  const jid = normalizeUserJid(rawPhoneOrJid);
  const now = Date.now();

  const res = db.prepare(`
    UPDATE users 
    SET is_admin = 0, updated_at = ?
    WHERE jid = ? OR phone = ?
  `).run(now, jid, phone);

  return res.changes > 0;
}

/**
 * Mengambil daftar Admin Bot
 */
function listBotAdmins() {
  const db = getDb();
  return db.prepare('SELECT id, jid, phone, name FROM users WHERE is_admin = 1').all();
}

/**
 * Mendaftarkan user oleh Admin
 */
function adminRegisterUser(rawPhoneOrJid, name, kota = '-', umur = 0) {
  const phone = extractPhone(rawPhoneOrJid);
  const cleanName = String(name || '').trim();
  const user = registerUserWithDetails(phone, {
    name: cleanName,
    kota,
    umur
  });
  if (user) {
    const db = getDb();
    db.prepare("UPDATE users SET limit_type = 'unlimited', unlimited = 1, updated_at = ? WHERE id = ?").run(Date.now(), user.id);
    user.limit_type = 'unlimited';
    user.unlimited = 1;
  }
  return user;
}

/**
 * Menghapus user dari database berdasarkan ID numerik atau nomor telepon/JID
 */
function deleteUser(rawPhoneOrJid) {
  const db = getDb();
  if (typeof rawPhoneOrJid === 'number' || (/^\d+$/.test(String(rawPhoneOrJid).trim()) && parseInt(rawPhoneOrJid, 10) < 100000)) {
    const id = parseInt(rawPhoneOrJid, 10);
    const byId = deleteUserById(id);
    if (byId) return true;
  }

  const phone = extractPhone(rawPhoneOrJid);
  const jid = normalizeUserJid(rawPhoneOrJid);
  const res = db.prepare('DELETE FROM users WHERE phone = ? OR jid = ?').run(phone, jid);
  return res.changes > 0;
}

/**
 * Mencatat log eksekusi command
 */
function logCommand(data) {
  const db = getDb();
  const now = data.timestamp || Date.now();
  const phone = extractPhone(data.number || data.userId);
  const jid = normalizeUserJid(data.userId || data.number);
  const status = data.status || 'SUCCESS';
  const isSuccess = status === 'SUCCESS' ? 1 : 0;
  const isFailed = status === 'FAILED' ? 1 : 0;

  try {
    db.prepare(`
      INSERT INTO command_logs (
        timestamp, user_id, number, username, command, arguments,
        chat_type, chat_id, group_name, status, execution_time, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      now,
      jid,
      phone,
      data.username || '',
      data.command || '',
      data.arguments || '',
      data.chatType || 'private',
      data.chatId || '',
      data.groupName || '',
      status,
      Number(data.executionTime) || 0,
      data.error || null
    );
  } catch (e) {
    console.error('[DB Log Error]', e.message);
  }

  // Update statistik user
  try {
    getUser(jid, data.username);
    db.prepare(`
      UPDATE users
      SET total_commands = COALESCE(total_commands, 0) + 1,
          success_commands = COALESCE(success_commands, 0) + ?,
          failed_commands = COALESCE(failed_commands, 0) + ?,
          last_command = ?,
          updated_at = ?
      WHERE jid = ? OR phone = ?
    `).run(isSuccess, isFailed, data.command, now, jid, phone);
  } catch (_) {}
}

/**
 * Mengambil log command terbaru
 */
function getRecentLogs(limit = 10, offset = 0) {
  const db = getDb();
  return db.prepare('SELECT * FROM command_logs ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, offset);
}

/**
 * Mengambil log berdasarkan nomor user
 */
function getLogsByUser(targetPhone, limit = 10) {
  const db = getDb();
  const clean = extractPhone(targetPhone);
  return db.prepare('SELECT * FROM command_logs WHERE number LIKE ? OR user_id LIKE ? ORDER BY id DESC LIMIT ?').all(`%${clean}%`, `%${clean}%`, limit);
}

/**
 * Mengambil log berdasarkan nama command
 */
function getLogsByCommand(cmdName, limit = 10) {
  const db = getDb();
  const cleanCmd = String(cmdName || '').replace(/^[./!]/, '').toLowerCase();
  return db.prepare('SELECT * FROM command_logs WHERE command = ? ORDER BY id DESC LIMIT ?').all(cleanCmd, limit);
}

/**
 * Mengambil log command yang gagal / error
 */
function getErrorLogs(limit = 10) {
  const db = getDb();
  return db.prepare("SELECT * FROM command_logs WHERE status = 'FAILED' ORDER BY id DESC LIMIT ?").all(limit);
}

/**
 * Mengambil log command download
 */
function getDownloadLogs(limit = 10) {
  const db = getDb();
  const dlCommands = ['play', 'play2', 'yts', 'tiktok', 'tiktokfoto', 'tiktokstalk', 'ig', 'igstory', 'facebook', 'twitter', 'spotify', 'mediafire', 'gdrive', 'gitclone', 'pinterest', 'img'];
  const placeholders = dlCommands.map(() => '?').join(',');
  return db.prepare(`SELECT * FROM command_logs WHERE command IN (${placeholders}) ORDER BY id DESC LIMIT ?`).all(...dlCommands, limit);
}

/**
 * Mengambil log command grup
 */
function getGroupLogs(limit = 10) {
  const db = getDb();
  return db.prepare("SELECT * FROM command_logs WHERE chat_type = 'group' ORDER BY id DESC LIMIT ?").all(limit);
}

/**
 * Statistik bot lengkap (.stats)
 */
function getBotStats(uptimeFormatted = '0m', groupCount = 0) {
  const db = getDb();
  const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const totalCommands = db.prepare('SELECT COUNT(*) as c FROM command_logs').get().c;
  const successCommands = db.prepare("SELECT COUNT(*) as c FROM command_logs WHERE status = 'SUCCESS'").get().c;
  const failedCommands = db.prepare("SELECT COUNT(*) as c FROM command_logs WHERE status = 'FAILED'").get().c;

  const dlCommands = ['play', 'play2', 'yts', 'tiktok', 'tiktokfoto', 'tiktokstalk', 'ig', 'igstory', 'facebook', 'twitter', 'spotify', 'mediafire', 'gdrive', 'gitclone', 'pinterest', 'img'];
  const totalDownloads = db.prepare(`SELECT COUNT(*) as c FROM command_logs WHERE command IN (${dlCommands.map(() => '?').join(',')})`).get(...dlCommands).c;

  const stkCommands = ['sticker', 'take', 'smaker', 'getsticker', 'emix', 'toimg', 'tovid', 'attp', 'ttp', 'brat', 'bratcolor', 'brathd', 'bratvid', 'bratvid2', 'brat2', 'brat3', 'anyabrat', 'animebrat', 'animebrat2', 'qc', 'qc2', 'smeme', 'emojigif', 'gifsticker', 'stly', 'stickerlysearch', 'telestick', 'tenor', 'stickersearch', 'ryo'];
  const totalStickers = db.prepare(`SELECT COUNT(*) as c FROM command_logs WHERE command IN (${stkCommands.map(() => '?').join(',')})`).get(...stkCommands).c;

  const ttsCommands = ['tts', 'say', 'tiktoktts'];
  const totalTts = db.prepare(`SELECT COUNT(*) as c FROM command_logs WHERE command IN (${ttsCommands.map(() => '?').join(',')})`).get(...ttsCommands).c;

  return {
    uptime: uptimeFormatted,
    users: totalUsers,
    groups: groupCount,
    commands: totalCommands,
    success: successCommands,
    failed: failedCommands,
    downloads: totalDownloads,
    stickers: totalStickers,
    tts: totalTts
  };
}

/**
 * Ringkasan statistik pengguna (.users)
 */
function getUsersOverview() {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const registered = db.prepare('SELECT COUNT(*) as c FROM users WHERE registered = 1').get().c;
  const premium = db.prepare('SELECT COUNT(*) as c FROM users WHERE premium = 1').get().c;
  const unlimited = db.prepare("SELECT COUNT(*) as c FROM users WHERE limit_type = 'unlimited' OR unlimited = 1").get().c;
  const banned = db.prepare('SELECT COUNT(*) as c FROM users WHERE banned = 1').get().c;

  // Active today: updated_at >= awal hari ini (pukul 00:00:00)
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const activeToday = db.prepare('SELECT COUNT(*) as c FROM users WHERE updated_at >= ?').get(startOfToday.getTime()).c;

  return {
    total,
    registered,
    premium,
    unlimited,
    banned,
    activeToday
  };
}

/**
 * Mengambil daftar user dengan pagination
 */
function getUsersPage(page = 1, pageSize = 10) {
  const db = getDb();
  const offset = Math.max(0, (page - 1) * pageSize);
  const total = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const totalPages = Math.ceil(total / pageSize) || 1;
  const users = db.prepare('SELECT * FROM users ORDER BY updated_at DESC LIMIT ? OFFSET ?').all(pageSize, offset);

  return {
    page,
    pageSize,
    total,
    totalPages,
    users
  };
}

module.exports = {
  getDb,
  getUser,
  getUserById,
  getAllRegisteredUsers,
  deleteUserById,
  getSmallestAvailableId,
  formatIndonesianDate,
  registerUser,
  registerUserWithDetails,
  incrementUsage,
  resetLimit,
  setUnlimited,
  setLimit,
  addPremium,
  removePremium,
  listPremiumUsers,
  getTodayDateString,
  getTimeUntilMidnightWib,
  getUserInfo,
  getUsersStats,
  normalizeUserJid,
  extractPhone,
  isBotAdmin,
  addBotAdmin,
  removeBotAdmin,
  listBotAdmins,
  adminRegisterUser,
  deleteUser,
  logCommand,
  getRecentLogs,
  getLogsByUser,
  getLogsByCommand,
  getErrorLogs,
  getDownloadLogs,
  getGroupLogs,
  getBotStats,
  getUsersOverview,
  getUsersPage,
  saveLidMapping,
  getPhoneByLid,
  getLidByPhone
};
