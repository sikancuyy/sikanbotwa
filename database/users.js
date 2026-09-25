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
  `);

  // Pastikan kolom-kolom baru tersedia pada tabel users
  try {
    const tableInfo = db.pragma('table_info(users)');
    const colNames = tableInfo.map((c) => c.name);

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
 * Cek apakah nomor merupakan salah satu nomor Owner terdaftar
 */
function isOwnerPhone(phone) {
  const clean = (phone || '').replace(/[^0-9]/g, '');
  const ownerNum = config.owner.number.replace(/[^0-9]/g, '');
  if (clean === ownerNum) return true;
  if (Array.isArray(config.owner.numbers)) {
    return config.owner.numbers.some((n) => n.replace(/[^0-9]/g, '') === clean);
  }
  return false;
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
    const isOwner = isOwnerPhone(phone);
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
  getUsersPage
};
