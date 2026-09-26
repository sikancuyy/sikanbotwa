const config = require('../config');

/**
 * Menu Utama Bertingkat SikanBot
 */
function getMainCategoryMenu(pushName = 'Kak', isRegistered = false) {
  const p = config.prefix;
  const unregNote = isRegistered ? '' : `\n\n⚠️ Kamu belum terdaftar.\nKetik: \`${p}daftar Nama User - Kota - Umur\``;
  const displayName = String(pushName || 'Kak').toUpperCase();

  return `╭───〔 🤖 SIKANBOT 〕
│
│ 👋 Halo ${displayName}!
│ Selamat datang di ${config.botName}.
│ Prefix : \`${p}\`
│
╰────────────────

╭───〔 📚 MENU 〕
│
├ ${p}inmenu = 📚 Menu Utama
├ ${p}indw = ⬇️ Download
├ ${p}inscr = 🔎 Pencarian
├ ${p}ingm = 🎮 Game
├ ${p}ins = 🖼️ Sticker
├ ${p}intts = 🔊 Text To Speech
│
├ ${p}inuser = 👤 Data User
├ ${p}intl = 🛠️ Tools
├ ${p}ingr = 👥 Fitur Grup
├ ${p}inadm = 👑 Menu Owner & Admin
│
├ ${p}inai = 🤖 AI
├ ${p}ininfo = ℹ️ Info Bot
└ ${p}inlog = 📋 Log Aktivitas

╰────────────────${unregNote}`;
}

function getGeneralMenu() {
  const p = config.prefix;
  return `╭───〔 📋 GENERAL 〕
│
├ ${p}menu
├ ${p}help
├ ${p}start
├ ${p}ping
├ ${p}pingdt
├ ${p}alive
├ ${p}uptime
├ ${p}runtime
├ ${p}bot
├ ${p}owner
├ ${p}script
├ ${p}infobot
├ ${p}donate
╰────────────────`;
}

function getDownloadMenu() {
  const p = config.prefix;
  return `╭───〔 📥 DOWNLOAD 〕
│
├ ${p}play / ${p}ytm
├ ${p}play2
├ ${p}yts
├ ${p}tt / ${p}tiktok
├ ${p}ttfoto / ${p}tiktokfoto
├ ${p}ttmusik / ${p}ttm / ${p}ttmp3
├ ${p}tiktokstalk
├ ${p}ig / ${p}reel
├ ${p}igstory / ${p}story
├ ${p}twitter
├ ${p}gitclone
╰────────────────`;
}

function getSearchMenu() {
  const p = config.prefix;
  return `╭───〔 🔎 SEARCH 〕
│
├ ${p}google
├ ${p}yts
╰────────────────`;
}

function getGameMenu() {
  const p = config.prefix;
  return `╭───〔 🎮 GAME & FUN 〕
│
├ ${p}tictactoe
├ ${p}delttt
├ ${p}math
├ ${p}ppt
├ ${p}slot
├ ${p}casino
├ ${p}yourmom
├ ${p}teri
├ ${p}tebakgambar
├ ${p}tebakkata
├ ${p}suit
├ ${p}coinflip
├ ${p}dadu
╰────────────────`;
}

function getStickerMenu() {
  const p = config.prefix;
  return `╭───〔 🧩 STICKER & MEDIA 〕
│
├ ${p}sticker [pack|author]
├ ${p}take / ${p}wm [pack|author]
├ ${p}smaker <teks>
├ ${p}getsticker <keyword>
├ ${p}stickersearch <query>
├ ${p}emix / ${p}emojimix
├ ${p}toimg
├ ${p}tovideo
├ ${p}attp <teks>
├ ${p}ttp <teks>
├ ${p}brat <teks>
├ ${p}bratpc <teks>
├ ${p}brat2 <teks>
├ ${p}brat3 <teks>
├ ${p}bratcolor <teks>|<bg>|<txt>
├ ${p}brathd <teks>
├ ${p}bratvid <teks>
├ ${p}bratvid2 <teks>
├ ${p}anyabrat <teks>
├ ${p}animebrat <teks>
├ ${p}animebrat2 <teks>
├ ${p}qc [warna]|[teks]
├ ${p}qc2 [warna]|[teks]
├ ${p}smeme <atas>|<bawah>
├ ${p}emojigif <emoji>
├ ${p}gifsticker <query>,<jml>
├ ${p}stly / ${p}stickerlysearch
├ ${p}telestick <url>
├ ${p}tenor <query>
├ ${p}ryo
╰────────────────`;
}

function getTtsMenu() {
  const p = config.prefix;
  return `╭───〔 🗣️ VOICE & TTS 〕
│
├ ${p}tts <teks>
├ ${p}tts <lang> <teks>
├ ${p}tiktoktts <teks>
├ ${p}say <teks>
╰────────────────`;
}

function getUserMenu() {
  const p = config.prefix;
  return `╭───〔 👤 USER & LIMIT 〕
│
├ ${p}daftar [nama]
├ ${p}register [nama]
├ ${p}me
├ ${p}limit
├ ${p}userinfo
╰────────────────`;
}

function getToolsMenu() {
  const p = config.prefix;
  return `╭───〔 🛠️ TOOLS 〕
│
├ ${p}calc
├ ${p}pdf
├ ${p}qrcode
├ ${p}shorturl
├ ${p}translate
├ ${p}ssweb
├ ${p}ocr
├ ${p}weather
├ ${p}vro (buka foto/video view once)
╰────────────────`;
}

function getGroupMenu() {
  const p = config.prefix;
  return `╭───〔 👥 GROUP 〕
│
├ ${p}add
├ ${p}kick
├ ${p}promote
├ ${p}demote
├ ${p}tagall
├ ${p}hidetag
├ ${p}groupinfo
├ ${p}linkgroup
├ ${p}revoke
├ ${p}open
├ ${p}close
├ ${p}warn
├ ${p}antilink
├ ${p}antispam
├ ${p}welcome
╰────────────────`;
}

function getAdminMenu() {
  const p = config.prefix;
  return `╭───〔 👑 *MENU OWNER & ADMIN* 〕
│
│ 📌 *Akses Khusus Owner & Admin Bot*
│
├─〔 👑 *KHUSUS OWNER* 〕
│ • *${p}addadmin <nomor>* : Angkat user jadi Admin Bot
│ • *${p}deladmin <nomor>* : Cabut hak Admin Bot
│ • *${p}listadmin* : Daftar seluruh Admin Bot & Owner
│ • *${p}restart* : Restart server bot
│ • *${p}shutdown* : Matikan sistem bot
│
├─〔 👤 *DATABASE USER* 〕
│ • *${p}users* / *${p}listuser* : Daftar semua user & statistik
│ • *${p}daftaruser <nomor>|<nama>* : Daftarkan user manual
│ • *${p}infouser <ID/nomor>* : Cek detail profil & limit user
│ • *${p}deluser <ID...>* : Hapus akun user dari database
│
├─〔 💎 *LIMIT & PREMIUM* 〕
│ • *${p}addprem <nomor> [durasi]* : Beri Premium (7d, 30d, perm)
│ • *${p}delprem <nomor>* : Cabut status Premium user
│ • *${p}listprem* : Daftar semua user Premium aktif
│ • *${p}resetlimit <nomor>* : Reset hit limit harian jadi 0
│ • *${p}setunlimited <nomor>* : Beri akses bebas limit
│ • *${p}setlimit <nomor> <jumlah>* : Atur kuota limit harian
│
├─〔 🚫 *MODERASI & BLOKIR* 〕
│ • *${p}ban <nomor>* : Banned user dari bot
│ • *${p}unban <nomor>* : Buka status banned user
│ • *${p}block [nomor]* : Blokir nomor di WhatsApp
│ • *${p}unblock [nomor]* : Buka blokir nomor di WhatsApp
│
├─〔 📢 *SIARAN & BROADCAST* 〕
│ • *${p}broadcast <pesan>* : Siaran ke semua grup bot
│ • *${p}brouser <pesan>* : Siaran ke semua user bot (PM)
│
├─〔 ⚙️ *KONTROL BOT* 〕
│ • *${p}join <link_grup>* : Gabung grup via tautan
│ • *${p}leave* : Keluar dari grup saat ini
│
├─〔 📊 *LOG & AUDIT* 〕
│ • *${p}pingdt* : Cek status & detail sistem (CPU, RAM, OS)
│ • *${p}logs [jumlah]* : Log command terbaru bot
│ • *${p}loguser <nomor>* : Riwayat aktivitas nomor user
│ • *${p}logcmd <cmd>* : Riwayat pemakaian command
│ • *${p}logerror* : Catatan error sistem terakhir
│ • *${p}logdownload* : Riwayat unduhan media
│ • *${p}loggroup* : Riwayat aktivitas bot di grup
│ • *${p}stats* : Statistik lengkap performa bot
│
╰────────────────
💡 *Catatan:* <wajib diisi>, [opsional]. Bisa balas (quote) chat user.`;
}

function getAiMenu() {
  const p = config.prefix;
  return `╭───〔 🤖 AI 〕
│
├ ${p}ai
├ ${p}ask
├ ${p}imagine
├ ${p}translate
├ ${p}summarize
╰────────────────`;
}

function getInfoMenu() {
  const p = config.prefix;
  return `╭───〔 ℹ️ BOT INFORMATION 〕
│
├ ${p}ping
├ ${p}pingdt
├ ${p}bot
├ ${p}infobot
├ ${p}owner
├ ${p}script
├ ${p}groups
├ ${p}blocklist
├ ${p}donate
├ ${p}stats
╰────────────────`;
}

function getLogMenu() {
  const p = config.prefix;
  return `╭───〔 📊 LOG & MONITORING 〕
│
├ ${p}pingdt
├ ${p}logs
├ ${p}loguser <nomor>
├ ${p}logcmd <command>
├ ${p}logerror
├ ${p}logdownload
├ ${p}loggroup
├ ${p}stats
╰────────────────`;
}

module.exports = {
  getMainCategoryMenu,
  getGeneralMenu,
  getDownloadMenu,
  getSearchMenu,
  getGameMenu,
  getStickerMenu,
  getTtsMenu,
  getUserMenu,
  getToolsMenu,
  getGroupMenu,
  getAdminMenu,
  getAiMenu,
  getInfoMenu,
  getLogMenu
};
