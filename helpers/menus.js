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
├ ${p}inadm = 👑 Admin Grup
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
├ ${p}play
├ ${p}play2
├ ${p}yts
├ ${p}tt / ${p}tiktok
├ ${p}ttfoto / ${p}tiktokfoto
├ ${p}ttmusik / ${p}ttmp3
├ ${p}tiktokstalk
├ ${p}ig / ${p}reel
├ ${p}igstory / ${p}story
├ ${p}facebook
├ ${p}twitter
├ ${p}spotify
├ ${p}mediafire
├ ${p}gdrive
├ ${p}gitclone
├ ${p}pinterest
├ ${p}img
╰────────────────`;
}

function getSearchMenu() {
  const p = config.prefix;
  return `╭───〔 🔎 SEARCH 〕
│
├ ${p}google
├ ${p}yts
├ ${p}img
├ ${p}pinterest
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
  return `╭───〔 👑 OWNER & ADMIN 〕
│
├ ${p}addadmin <nomor>
├ ${p}deladmin <nomor>
├ ${p}listadmin
├ ${p}daftaruser <nomor>|<nama>
├ ${p}deluser <ID...>
├ ${p}listuser
├ ${p}users
├ ${p}infouser <ID>
├ ${p}resetlimit <nomor>
├ ${p}setunlimited <nomor>
├ ${p}setlimit <nomor>
├ ${p}addprem
├ ${p}delprem
├ ${p}listprem
├ ${p}ban
├ ${p}unban
├ ${p}block
├ ${p}unblock
├ ${p}broadcast
├ ${p}join
├ ${p}leave
├ ${p}restart
├ ${p}shutdown
╰────────────────`;
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
