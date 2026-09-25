const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');

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
  `);

  // Pastikan kolom is_admin ada pada tabel lama jika belum ada
  try {
    const tableInfo = db.pragma('table_info(users)');
    const hasIsAdmin = tableInfo.some((col) => col.name === 'is_admin');
    if (!hasIsAdmin) {
      db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0;');
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

/**
 * Normalisasi JID agar format seragam
 */
function normalizeUserJid(rawJid) {
  if (!rawJid) return '';
  const num = String(rawJid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
  return num ? `${num}@s.whatsapp.net` : String(rawJid).trim();
}

function extractPhone(rawJid) {
  if (!rawJid) return '';
  return String(rawJid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}

/**
 * Ambil atau inisialisasi user baru di database SQLite
 */
function getUser(rawJid, pushName = '') {
  const db = getDb();
  const jid = normalizeUserJid(rawJid);
  const phone = extractPhone(rawJid);
  if (!jid) return null;

  let user = db.prepare('SELECT * FROM users WHERE jid = ?').get(jid);
  if (!user && phone) {
    user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  }

  if (!user) {
    const now = Date.now();
    const isOwner = phone === config.owner.number.replace(/[^0-9]/g, '');
    const registered = isOwner ? 1 : 0;
    const limitType = isOwner ? 'unlimited' : 'limited';
    const initialName = isOwner ? config.owner.name : (pushName || '');

    const info = db.prepare(`
      INSERT INTO users (jid, phone, name, registered, created_at, updated_at, usage_count, limit_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(jid, phone, initialName, registered, now, now, 0, limitType);

    user = {
      id: info.lastInsertRowid,
      jid,
      phone,
      name: initialName,
      registered,
      created_at: now,
      updated_at: now,
      usage_count: 0,
      limit_type: limitType
    };
  } else if (pushName && !user.name) {
    // Perbarui nama dari pushName jika sebelumnya belum terisi
    db.prepare('UPDATE users SET name = ?, updated_at = ? WHERE id = ?').run(pushName, Date.now(), user.id);
    user.name = pushName;
  }

  return user;
}

/**
 * Mendaftarkan user (registrasi nama)
 */
function registerUser(rawJid, fullName) {
  const db = getDb();
  const jid = normalizeUserJid(rawJid);
  getUser(jid); // Pastikan record ada

  const now = Date.now();
  const cleanName = String(fullName || '').trim();
  db.prepare(`
    UPDATE users 
    SET name = ?, registered = 1, limit_type = 'unlimited', updated_at = ?
    WHERE jid = ?
  `).run(cleanName, now, jid);

  return getUser(jid);
}

/**
 * Menambah penggunaan limit (increment usage)
 */
function incrementUsage(rawJid, amount = 1) {
  const db = getDb();
  const jid = normalizeUserJid(rawJid);
  const user = getUser(jid);
  if (!user) return null;

  const now = Date.now();
  db.prepare(`
    UPDATE users
    SET usage_count = usage_count + ?, updated_at = ?
    WHERE jid = ?
  `).run(amount, now, jid);

  user.usage_count += amount;
  user.updated_at = now;
  return user;
}

/**
 * Reset limit penggunaan ke 0
 */
function resetLimit(rawPhoneOrJid) {
  const db = getDb();
  const phone = extractPhone(rawPhoneOrJid);
  const jid = normalizeUserJid(rawPhoneOrJid);
  const now = Date.now();

  const res = db.prepare(`
    UPDATE users
    SET usage_count = 0, updated_at = ?
    WHERE jid = ? OR phone = ?
  `).run(now, jid, phone);

  return res.changes > 0;
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
    SET limit_type = 'unlimited', registered = 1, updated_at = ?
    WHERE jid = ? OR phone = ?
  `).run(now, jid, phone);

  return res.changes > 0;
}

/**
 * Mengubah status user menjadi Limited (limit 50)
 */
function setLimit(rawPhoneOrJid) {
  const db = getDb();
  const phone = extractPhone(rawPhoneOrJid);
  const jid = normalizeUserJid(rawPhoneOrJid);
  const now = Date.now();

  // Pastikan user ada
  getUser(jid);

  const res = db.prepare(`
    UPDATE users
    SET limit_type = 'limited', registered = 0, usage_count = 0, updated_at = ?
    WHERE jid = ? OR phone = ?
  `).run(now, jid, phone);

  return res.changes > 0;
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
  const ownerNum = config.owner.number.replace(/[^0-9]/g, '');

  if (phone === ownerNum) return true;

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

  getUser(jid); // Pastikan record ada

  db.prepare(`
    UPDATE users 
    SET is_admin = 1, registered = 1, limit_type = 'unlimited', updated_at = ?
    WHERE jid = ? OR phone = ?
  `).run(now, jid, phone);

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
function adminRegisterUser(rawPhoneOrJid, name) {
  const db = getDb();
  const phone = extractPhone(rawPhoneOrJid);
  const jid = normalizeUserJid(rawPhoneOrJid);
  const cleanName = String(name || '').trim();
  const now = Date.now();

  getUser(jid, cleanName);

  db.prepare(`
    UPDATE users 
    SET name = ?, registered = 1, limit_type = 'unlimited', updated_at = ?
    WHERE jid = ? OR phone = ?
  `).run(cleanName, now, jid, phone);

  return getUser(jid);
}

/**
 * Menghapus user dari database (reset data user sepenuhnya)
 */
function deleteUser(rawPhoneOrJid) {
  const db = getDb();
  const phone = extractPhone(rawPhoneOrJid);
  const jid = normalizeUserJid(rawPhoneOrJid);

  const res = db.prepare('DELETE FROM users WHERE jid = ? OR phone = ?').run(jid, phone);
  return res.changes > 0;
}

module.exports = {
  getDb,
  getUser,
  registerUser,
  incrementUsage,
  resetLimit,
  setUnlimited,
  setLimit,
  getUserInfo,
  getUsersStats,
  normalizeUserJid,
  extractPhone,
  isBotAdmin,
  addBotAdmin,
  removeBotAdmin,
  listBotAdmins,
  adminRegisterUser,
  deleteUser
};
