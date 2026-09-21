const fs = require('fs');
const path = require('path');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const config = require('./config');
const db = require('./lib/database');
const games = require('./lib/games');
const scraper = require('./lib/scraper');
const { mediaToWebp, webpToImage, webpToVideo, createAttpSticker, createTextSticker, createBratSticker } = require('./lib/sticker');
const { formatBytes, formatUptime, log, deleteFileSafe } = require('./utils');
const { downloadVideo } = require('./downloader');

/**
 * Unduh buffer media dari objek pesan Baileys
 */
async function getMediaBuffer(mediaObj, type) {
  try {
    const stream = await downloadContentFromMessage(mediaObj, type);
    let buffer = Buffer.from([]);
    for await (const chunk of stream) {
      buffer = Buffer.concat([buffer, chunk]);
    }
    return buffer;
  } catch (err) {
    throw new Error('Gagal mengunduh media dari pesan: ' + err.message);
  }
}

/**
 * Handler utama pesan WhatsApp
 */
async function handleMessage(sock, msg, startTime) {
  if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

  const chatId = msg.key.remoteJid;
  const isGroup = chatId.endsWith('@g.us');
  const sender = isGroup ? (msg.key.participant || msg.participant) : chatId;
  const senderNumber = sender ? sender.split('@')[0] : '';
  const isOwner = db.isOwner(sender);
  const isPrem = db.isPremium(sender);
  const isBanned = db.isBanned(sender);

  // 1. Unwrap Baileys wrappers (ephemeralMessage, viewOnceMessage, viewOnceMessageV2, documentWithCaptionMessage)
  let rawMessage = msg.message;
  while (
    rawMessage?.ephemeralMessage ||
    rawMessage?.viewOnceMessage ||
    rawMessage?.viewOnceMessageV2 ||
    rawMessage?.documentWithCaptionMessage
  ) {
    rawMessage = (
      rawMessage.ephemeralMessage?.message ||
      rawMessage.viewOnceMessage?.message ||
      rawMessage.viewOnceMessageV2?.message ||
      rawMessage.documentWithCaptionMessage?.message
    );
  }

  // 2. Unwrap Quoted Message
  let quotedMessage = rawMessage?.extendedTextMessage?.contextInfo?.quotedMessage || null;
  while (
    quotedMessage?.ephemeralMessage ||
    quotedMessage?.viewOnceMessage ||
    quotedMessage?.viewOnceMessageV2 ||
    quotedMessage?.documentWithCaptionMessage
  ) {
    quotedMessage = (
      quotedMessage.ephemeralMessage?.message ||
      quotedMessage.viewOnceMessage?.message ||
      quotedMessage.viewOnceMessageV2?.message ||
      quotedMessage.documentWithCaptionMessage?.message
    );
  }

  let body = (
    rawMessage?.conversation ||
    rawMessage?.extendedTextMessage?.text ||
    rawMessage?.imageMessage?.caption ||
    rawMessage?.videoMessage?.caption ||
    rawMessage?.documentMessage?.caption ||
    ''
  ).trim();

  // Objek helper reply
  const reply = async (text, options = {}) => {
    return await sock.sendMessage(chatId, { text, ...options }, { quoted: msg });
  };

  // Cek apakah user diblokir/banned
  if (isBanned && !isOwner) {
    if (body.startsWith(config.prefix)) {
      return reply('🚫 Akun Anda telah dibanned dari penggunaan *SikanBot*. Hubungi Owner untuk unban.');
    }
    return;
  }

  // Konfigurasi grup
  let groupMetadata = null;
  let groupName = '';
  let groupMembers = [];
  let groupAdmins = [];
  let isBotAdmin = false;
  let isAdmin = false;

  if (isGroup) {
    try {
      groupMetadata = await sock.groupMetadata(chatId);
      groupName = groupMetadata.subject;
      groupMembers = groupMetadata.participants || [];
      groupAdmins = groupMembers.filter((m) => m.admin).map((m) => m.id);

      const botJid = sock.user?.id?.split(':')[0] + '@s.whatsapp.net';
      isBotAdmin = groupAdmins.includes(botJid);
      isAdmin = groupAdmins.includes(sender);
    } catch (_) { }

    const groupConfig = db.getGroup(chatId);

    // 1. Antilink Protection
    if (groupConfig.antilink && !isAdmin && !isOwner) {
      const linkRegex = /(chat\.whatsapp\.com\/[0-9A-Za-z]{20,24})/i;
      if (linkRegex.test(body)) {
        await sock.sendMessage(chatId, {
          text: `⚠️ *ANTI LINK DETECTED*\n\nMaaf @${senderNumber}, tautan grup WhatsApp dilarang di sini!`,
          mentions: [sender]
        }, { quoted: msg });

        if (isBotAdmin) {
          try {
            await sock.sendMessage(chatId, { delete: msg.key });
          } catch (_) { }
        }
        return;
      }
    }
  }

  // 2. Cek Game TicTacToe Aktif di Chat ini
  const tttSession = games.tttSessions.get(chatId);
  if (tttSession && !body.startsWith(config.prefix)) {
    if (/^[1-9]$/.test(body.trim())) {
      const turnResult = games.playTTT(chatId, sender, body.trim());
      if (turnResult.status) {
        let msgOut = turnResult.boardText;
        if (turnResult.over) {
          msgOut += `\n${turnResult.message}`;
          return await sock.sendMessage(chatId, {
            text: msgOut,
            mentions: turnResult.winner ? [turnResult.winner] : []
          }, { quoted: msg });
        } else {
          msgOut += `\nGiliran: @${turnResult.nextTurn.split('@')[0]} (Pilih nomor 1-9)`;
          return await sock.sendMessage(chatId, {
            text: msgOut,
            mentions: [turnResult.nextTurn]
          }, { quoted: msg });
        }
      } else {
        return reply(turnResult.message);
      }
    }
  }

  // 3. Cek Game Tebak-tebakan / Kuis Aktif
  const activeQuiz = games.quizSessions.get(chatId);
  if (activeQuiz && !body.startsWith(config.prefix)) {
    if (body.toUpperCase().trim() === activeQuiz.answer.toUpperCase().trim()) {
      clearTimeout(activeQuiz.timer);
      games.quizSessions.delete(chatId);

      db.updateUser(sender, (u) => {
        u.balance = (u.balance || 0) + (activeQuiz.points || 100);
      });

      return reply(`🎉 *BENAR SEKALI!*\n\nJawaban: *${activeQuiz.answer}*\nPemenang: @${senderNumber}\nHadiah: +${activeQuiz.points} koin 🪙`, {
        mentions: [sender]
      });
    }
  }

  // Cek Prefix
  const matchedPrefix = config.prefixes.find((p) => body.startsWith(p));
  if (!matchedPrefix) {
    // Deteksi URL video otomatis di private chat
    const urlMatch = body.match(/https?:\/\/[^\s]+/i);
    if (urlMatch && !isGroup) {
      const detectedUrl = urlMatch[0];
      const requestId = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      try {
        await reply('⏳ Sedang memproses link video Anda...');
        const result = await downloadVideo(detectedUrl, requestId);
        const videoBuffer = fs.readFileSync(result.filePath);
        await sock.sendMessage(chatId, {
          video: videoBuffer,
          caption: `🎥 *${result.title}*\n📦 Ukuran: ${formatBytes(result.fileSize)}`,
          mimetype: 'video/mp4'
        }, { quoted: msg });
        deleteFileSafe(result.filePath);
      } catch (e) { }
    }
    return;
  }

  // Parse Command & Arguments
  const args = body.slice(matchedPrefix.length).trim().split(/\s+/);
  let command = (args.shift() || '').toLowerCase();
  const q = args.join(' ');

  // Daftar Alias Perintah
  const aliases = {
    // Download
    'tt': 'tiktok',
    'ttstalk': 'tiktokstalk',
    'stalktt': 'tiktokstalk',
    'instagram': 'ig',
    'fb': 'facebook',
    'tw': 'twitter',
    'x': 'twitter',
    'pin': 'pinterest',
    'mf': 'mediafire',
    'gd': 'gdrive',
    'git': 'gitclone',
    'image': 'img',
    // Search
    'g': 'google',
    // Game
    'ttt': 'tictactoe',
    'coin': 'coinflip',
    'dice': 'dadu',
    // Sticker
    's': 'sticker',
    'stk': 'sticker',
    'stiker': 'sticker',
    'wm': 'take',
    'buka': 'toimg',
    // Tools
    'qr': 'qrcode',
    'short': 'shorturl',
    'tr': 'translate',
    'ss': 'ssweb',
    'cuaca': 'weather',
    // Group
    'infogc': 'groupinfo',
    'linkgc': 'linkgroup',
    // Owner
    'bc': 'broadcast',
    'own': 'owner',
    // AI
    'sum': 'summarize',
    'ringkas': 'summarize',
    // Bot
    'info': 'infobot',
    'start': 'menu'
  };

  if (aliases[command]) {
    command = aliases[command];
  }

  // Quoted message helper
  const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage || null;
  const quotedType = quoted ? Object.keys(quoted)[0] : null;

  db.incrementHit();

  /* ====================================================================
   * 1. 🤖 BOT MENU
   * ==================================================================== */
  if (command === 'menu' || command === 'help' || command === 'start') {
    const menuTemplate = `
╭───〔 🤖 BOT MENU 〕
│
├ .menu (.start)
├ .help
├ .ping
├ .alive
├ .uptime
├ .runtime
├ .bot
├ .owner
├ .script
├ .infobot
├ .donate
├ .groups
├ .blocklist
╰──────────────

╭───〔 📥 DOWNLOAD 〕
│
├ .play
├ .play2
├ .yts
├ .tt (tiktok)
├ .tiktokstalk
├ .ig
├ .facebook
├ .twitter
├ .spotify
├ .mediafire
├ .gdrive
├ .gitclone
├ .pinterest
├ .img
╰──────────────

╭───〔 🔎 SEARCH 〕
│
├ .google
├ .yts
├ .img
├ .pinterest
╰──────────────

╭───〔 🎮 GAME & FUN 〕
│
├ .tictactoe
├ .delttt
├ .math
├ .ppt
├ .slot
├ .casino
├ .yourmom
├ .teri
├ .tebakgambar
├ .tebakkata
├ .suit
├ .coinflip
├ .dadu
╰──────────────

╭───〔 🧩 STICKER 〕
│
├ .sticker
├ .take
├ .smaker
├ .getsticker
├ .emix
├ .toimg
├ .tovid
├ .attp
├ .brat
╰──────────────

╭───〔 🛠️ TOOLS 〕
│
├ .calc
├ .pdf
├ .qrcode
├ .shorturl
├ .translate
├ .ssweb
├ .ocr
├ .weather
╰──────────────

╭───〔 👥 GROUP 〕
│
├ .add
├ .kick
├ .promote
├ .demote
├ .tagall
├ .hidetag
├ .groupinfo
├ .linkgroup
├ .revoke
├ .open
├ .close
├ .warn
├ .antilink
├ .antispam
├ .welcome
╰──────────────

╭───〔 👑 OWNER 〕
│
├ .addprem
├ .delprem
├ .listprem
├ .ban
├ .unban
├ .block
├ .unblock
├ .broadcast
├ .join
├ .leave
├ .restart
├ .shutdown
╰──────────────

╭───〔 🤖 AI 〕
│
├ .ai
├ .ask
├ .imagine
├ .translate
├ .summarize
╰──────────────
`.trim();

    const banner = `👋 Halo @${senderNumber}!\nSelamat datang di *${config.botName}*.\nPrefix: *${config.prefix}*\n\n` + menuTemplate;
    return await reply(banner, { mentions: [sender] });
  }

  if (command === 'ping') {
    const start = Date.now();
    await reply('🏓 Menghitung latency...');
    const latency = Date.now() - start;
    return await sock.sendMessage(chatId, {
      text: `🏓 *Pong!*\n\n⚡ *Kecepatan Respon:* ${latency} ms\n⏱️ *Uptime:* ${formatUptime(Math.floor((Date.now() - startTime) / 1000))}\n🟢 *Server:* Aktif & Normal`
    }, { quoted: msg });
  }

  if (command === 'alive') {
    return reply(`🟢 *${config.botName}* Berjalan Aktif!\nSemua sistem downloader, game, tools, dan modul AI siap digunakan 24/7.`);
  }

  if (command === 'uptime' || command === 'runtime') {
    const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
    return reply(`⏱️ *Uptime Bot:* ${formatUptime(uptimeSec)}\n🗓️ *Waktu Mulai:* ${new Date(startTime).toLocaleString('id-ID')}`);
  }

  if (command === 'bot' || command === 'infobot') {
    const mem = process.memoryUsage();
    return reply(`🤖 *INFORMASI BOT*\n\n` +
      `• *Nama:* ${config.botName}\n` +
      `• *Versi:* ${config.botVersion}\n` +
      `• *Node.js:* ${process.version}\n` +
      `• *Platform:* ${process.platform} (${process.arch})\n` +
      `• *RAM Digunakan:* ${formatBytes(mem.rss)}\n` +
      `• *Prefix:* ${config.prefix}\n` +
      `• *Total Hit Perintah:* ${db.data.settings?.totalHits || 1}\n` +
      `• *Owner:* ${config.owner.name}`);
  }

  if (command === 'owner') {
    if (args[0] === 'short') {
      const shortCard = `╭──〔 👑 OWNER 〕
│
│ 👤 Nama   : ${config.owner.name}
│ 💻 Role   : ${config.owner.role}
│ 🤖 Bot    : ${config.botName}
│ 🎓 Kampus : ${config.owner.campus}
│
│ 📱 WhatsApp : [${config.owner.phone}]
│ 📷 Instagram: [${config.owner.instagram}]
│ 💻 GitHub   : [${config.owner.github}]
│
╰──────────────`;
      return reply(shortCard);
    }

    const fullCard = `👑 OWNER — ${config.botName}

╭───〔 👑 OWNER BOT 〕
│
├ Nama      : ${config.owner.name}
├ Status    : ${config.owner.status}
├ Pendidikan: ${config.owner.education}
├ Kampus    : ${config.owner.campus}
├ Jurusan   : ${config.owner.major}
│
├ WhatsApp  : [${config.owner.phone}]
├ Instagram : [${config.owner.instagram}]
├ Email     : [${config.owner.email}]
│
├ Bot       : ${config.botName}
├ Prefix    : ${config.prefix}
│
╰──────────────


╭──〔 👑 OWNER 〕
│
│ 👤 Nama   : ${config.owner.name}
│ 💻 Role   : ${config.owner.role}
│ 🤖 Bot    : ${config.botName}
│ 🎓 Kampus : ${config.owner.campus}
│
│ 📱 WhatsApp : [${config.owner.phone}]
│ 📷 Instagram: [${config.owner.instagram}]
│ 💻 GitHub   : [${config.owner.github}]
│
╰──────────────`;

    return reply(fullCard);
  }

  if (command === 'script') {
    return reply(`💻 *SCRIPT BOT*\n\nRepository: https://github.com/${config.owner.github}/sikanbot\nDeveloper: ${config.owner.name}\nBase: @whiskeysockets/baileys & Node.js`);
  }

  if (command === 'donate') {
    return reply(`☕ *DONASI & DUKUNGAN*\n\n` +
      `Bantu server bot tetap menyala dengan donasi seikhlasnya:\n` +
      `• DANA: *${config.donate.dana}*\n` +
      `• GoPay: *${config.donate.gopay}*\n` +
      `• Saweria: *${config.donate.saweria}*\n\n` +
      `Terima kasih atas dukungan Anda! 🙏`);
  }

  if (command === 'groups') {
    try {
      const allGroups = await sock.groupFetchAllParticipating();
      const list = Object.values(allGroups);
      let out = `👥 *DAFTAR GRUP BOT (${list.length})*\n\n`;
      list.forEach((g, i) => {
        out += `${i + 1}. *${g.subject}*\n   ID: ${g.id}\n   Member: ${g.participants.length}\n\n`;
      });
      return reply(out.trim());
    } catch (e) {
      return reply('Gagal mengambil daftar grup.');
    }
  }

  if (command === 'blocklist') {
    try {
      const blocklist = await sock.fetchBlocklist();
      if (!blocklist || blocklist.length === 0) {
        return reply('Daftar kontak yang diblokir saat ini kosong.');
      }
      let out = `🚫 *DAFTAR KONTAK DIBLOKIR (${blocklist.length})*\n\n`;
      blocklist.forEach((b, i) => {
        out += `${i + 1}. @${b.split('@')[0]}\n`;
      });
      return reply(out, { mentions: blocklist });
    } catch (e) {
      return reply('Gagal mengambil daftar kontak yang diblokir.');
    }
  }

  /* ====================================================================
   * 2. 📥 DOWNLOAD
   * ==================================================================== */
  if (command === 'play') {
    if (!q) return reply(`Masukkan judul lagu atau link YouTube!\nContoh: *${config.prefix}play Denny Caknan Cundamani*`);
    await reply('🎵 Mencari dan mengunduh lagu...');

    const tempAudio = path.join(config.tempDir, `audio_${Date.now()}.mp3`);
    try {
      const dlRes = await scraper.downloadYouTubeAudio(q, tempAudio);
      if (dlRes.success && fs.existsSync(tempAudio)) {
        const audioBuffer = fs.readFileSync(tempAudio);
        await sock.sendMessage(chatId, {
          audio: audioBuffer,
          mimetype: 'audio/mp4',
          ptt: false
        }, { quoted: msg });
        deleteFileSafe(tempAudio);
      } else {
        reply('❌ Gagal mengunduh audio.');
      }
    } catch (e) {
      deleteFileSafe(tempAudio);
      reply(`❌ Error: ${e.message}`);
    }
    return;
  }

  if (command === 'play2') {
    if (!q) return reply(`Masukkan judul video atau link YouTube!\nContoh: *${config.prefix}play2 anime edit*`);
    await reply('🎬 Mencari dan mengunduh video...');

    const tempVideo = path.join(config.tempDir, `vid_${Date.now()}.mp4`);
    try {
      const dlRes = await scraper.downloadYouTubeVideo(q, tempVideo);
      if (dlRes.success && fs.existsSync(tempVideo)) {
        const vidBuffer = fs.readFileSync(tempVideo);
        await sock.sendMessage(chatId, {
          video: vidBuffer,
          caption: `🎥 *YouTube Video:* ${dlRes.title}`,
          mimetype: 'video/mp4'
        }, { quoted: msg });
        deleteFileSafe(tempVideo);
      } else {
        reply('❌ Gagal mengunduh video.');
      }
    } catch (e) {
      deleteFileSafe(tempVideo);
      reply(`❌ Error: ${e.message}`);
    }
    return;
  }

  if (command === 'tiktok') {
    if (!q) return reply(`Masukkan link video TikTok!\nContoh: *${config.prefix}tiktok https://vt.tiktok.com/...*`);
    await reply('⏳ Mengunduh video TikTok tanpa watermark...');
    try {
      const data = await scraper.getTikTok(q);
      await sock.sendMessage(chatId, {
        video: { url: data.videoUrl },
        caption: `✨ *TikTok No Watermark*\n\n👤 Author: ${data.author}\n📝 Caption: ${data.title}`
      }, { quoted: msg });
    } catch (e) {
      // Fallback ke yt-dlp
      const reqId = `tt_${Date.now()}`;
      try {
        const result = await downloadVideo(q, reqId);
        const vidBuf = fs.readFileSync(result.filePath);
        await sock.sendMessage(chatId, {
          video: vidBuf,
          caption: `✨ *TikTok Video:* ${result.title}`
        }, { quoted: msg });
        deleteFileSafe(result.filePath);
      } catch (err2) {
        reply(`❌ Gagal mendownload TikTok: ${err2.message}`);
      }
    }
    return;
  }

  if (command === 'tiktokstalk') {
    if (!q) return reply(`Masukkan username TikTok!\nContoh: *${config.prefix}tiktokstalk sandikagalih*`);
    await reply('🔍 Mencari profil TikTok...');
    try {
      const prof = await scraper.stalkTikTok(q);
      const text = `👤 *TIKTOK STALK PROFILE*\n\n` +
        `• *Nama:* ${prof.nickname} (@${prof.username})\n` +
        `• *Followers:* ${Number(prof.followers).toLocaleString('id-ID')}\n` +
        `• *Following:* ${Number(prof.following).toLocaleString('id-ID')}\n` +
        `• *Likes/Hearts:* ${Number(prof.hearts).toLocaleString('id-ID')}\n` +
        `• *Total Video:* ${prof.videos}\n` +
        `• *Verified:* ${prof.verified ? '✅ Ya' : '❌ Tidak'}\n` +
        `• *Bio:* ${prof.bio}`;

      if (prof.avatar) {
        await sock.sendMessage(chatId, {
          image: { url: prof.avatar },
          caption: text
        }, { quoted: msg });
      } else {
        reply(text);
      }
    } catch (e) {
      reply(`❌ Gagal mengambil profil: ${e.message}`);
    }
    return;
  }

  if (command === 'ig' || command === 'facebook' || command === 'twitter') {
    if (!q) return reply(`Masukkan URL ${command}!\nContoh: *${config.prefix}${command} https://...*`);
    await reply(`⏳ Mengunduh video dari ${command}...`);
    const reqId = `${command}_${Date.now()}`;
    try {
      const res = await downloadVideo(q, reqId);
      const videoBuff = fs.readFileSync(res.filePath);
      await sock.sendMessage(chatId, {
        video: videoBuff,
        caption: `🎥 *${res.title}*\n📦 Ukuran: ${formatBytes(res.fileSize)}`
      }, { quoted: msg });
      deleteFileSafe(res.filePath);
    } catch (err) {
      reply(`❌ Gagal mengunduh: ${err.message}`);
    }
    return;
  }

  if (command === 'spotify') {
    if (!q) return reply(`Masukkan judul lagu Spotify!\nContoh: *${config.prefix}spotify Nadin Amizah Rayuan Perempuan Gila*`);
    await reply('🔍 Mencari dan mengunduh lagu Spotify...');
    const tempAudio = path.join(config.tempDir, `spotify_${Date.now()}.mp3`);
    try {
      const dlRes = await scraper.downloadYouTubeAudio(q, tempAudio);
      if (dlRes.success && fs.existsSync(tempAudio)) {
        const audioBuffer = fs.readFileSync(tempAudio);
        await sock.sendMessage(chatId, {
          audio: audioBuffer,
          mimetype: 'audio/mp4',
          ptt: false
        }, { quoted: msg });
        deleteFileSafe(tempAudio);
      } else {
        reply('❌ Gagal mengunduh lagu.');
      }
    } catch (e) {
      deleteFileSafe(tempAudio);
      reply(`❌ Error: ${e.message}`);
    }
    return;
  }

  if (command === 'mediafire') {
    if (!q) return reply(`Masukkan link Mediafire!\nContoh: *${config.prefix}mediafire https://www.mediafire.com/file/...*`);
    await reply('⏳ Mengekstrak tautan Mediafire...');
    try {
      const mf = await scraper.getMediafire(q);
      reply(`📁 *MEDIAFIRE DOWNLOADER*\n\n• *Nama:* ${mf.filename}\n• *Ukuran:* ${mf.size}\n• *Link Unduh Langsung:* ${mf.downloadUrl}`);
    } catch (e) {
      reply(`❌ Gagal: ${e.message}`);
    }
    return;
  }

  if (command === 'gdrive') {
    if (!q) return reply(`Masukkan link Google Drive!\nContoh: *${config.prefix}gdrive https://drive.google.com/file/d/.../view*`);
    const match = q.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (!match) return reply('❌ Link Google Drive tidak valid.');
    const fileId = match[1];
    const directUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
    return reply(`📁 *GOOGLE DRIVE DOWNLOADER*\n\n• *ID File:* ${fileId}\n• *Direct Download:* ${directUrl}`);
  }

  if (command === 'gitclone') {
    if (!q) return reply(`Masukkan link GitHub repository!\nContoh: *${config.prefix}gitclone https://github.com/user/repo*`);
    try {
      const repoData = scraper.getGitClone(q);
      await sock.sendMessage(chatId, {
        document: { url: repoData.zipUrl },
        fileName: repoData.filename,
        mimetype: 'application/zip',
        caption: `📦 *GitHub Repository:* ${repoData.user}/${repoData.repo}`
      }, { quoted: msg });
    } catch (e) {
      reply(`❌ Gagal mengunduh repo: ${e.message}`);
    }
    return;
  }

  if (command === 'pinterest') {
    if (!q) return reply(`Masukkan kata kunci atau link Pinterest!\nContoh: *${config.prefix}pinterest anime aesthetic*`);
    await reply('🔍 Mencari di Pinterest...');
    try {
      const pins = await scraper.searchPinterest(q);
      if (pins.length > 0) {
        const chosen = pins[Math.floor(Math.random() * Math.min(pins.length, 5))];
        await sock.sendMessage(chatId, {
          image: { url: chosen.image },
          caption: `📌 *Pinterest:* ${chosen.title}`
        }, { quoted: msg });
      } else {
        reply('❌ Gambar tidak ditemukan.');
      }
    } catch (e) {
      reply(`❌ Error Pinterest: ${e.message}`);
    }
    return;
  }

  if (command === 'img') {
    if (!q) return reply(`Masukkan kata kunci pencarian gambar!\nContoh: *${config.prefix}img mobil sport*`);
    await reply('🔍 Mencari gambar...');
    try {
      const list = await scraper.searchImages(q);
      if (list.length > 0) {
        const item = list[0];
        await sock.sendMessage(chatId, {
          image: { url: item.image },
          caption: `🖼️ *Gambar:* ${item.title}`
        }, { quoted: msg });
      } else {
        reply('❌ Gambar tidak ditemukan.');
      }
    } catch (e) {
      reply(`❌ Error gambar: ${e.message}`);
    }
    return;
  }

  /* ====================================================================
   * 3. 🔎 SEARCH
   * ==================================================================== */
  if (command === 'google') {
    if (!q) return reply(`Masukkan query pencarian Google!\nContoh: *${config.prefix}google penemu komputer*`);
    await reply('🔍 Mencari di Google...');
    try {
      const results = await scraper.searchGoogle(q);
      if (results.length === 0) return reply('Tidak ditemukan hasil untuk pencarian tersebut.');
      let text = `🔎 *HASIL PENCARIAN GOOGLE*\n_Query: ${q}_\n\n`;
      results.forEach((r, i) => {
        text += `${i + 1}. *${r.title}*\n${r.snippet}\n🔗 ${r.url}\n\n`;
      });
      return reply(text.trim());
    } catch (e) {
      return reply(`❌ Error search: ${e.message}`);
    }
  }

  if (command === 'yts') {
    if (!q) return reply(`Masukkan judul video YouTube!\nContoh: *${config.prefix}yts tutorial nodejs*`);
    await reply('🔍 Mencari video di YouTube...');
    try {
      const list = await scraper.searchYouTube(q, 5);
      if (list.length === 0) return reply('Video tidak ditemukan.');
      let out = `🎬 *HASIL PENCARIAN YOUTUBE*\n\n`;
      list.forEach((v, i) => {
        out += `${i + 1}. *${v.title}*\n⏱️ Durasi: ${v.duration} | 👤 Channel: ${v.author}\n🔗 ${v.url}\n\n`;
      });
      return reply(out.trim());
    } catch (e) {
      return reply(`❌ Error YouTube search: ${e.message}`);
    }
  }

  /* ====================================================================
   * 4. 🎮 GAME & FUN
   * ==================================================================== */
  if (command === 'tictactoe') {
    if (args[0] === 'join') {
      const res = games.joinTTT(chatId, sender);
      if (!res.status) return reply(res.message);
      return await sock.sendMessage(chatId, {
        text: `🎮 *Game TicTacToe Dimulai!*\n\n❌ Pemain 1: @${res.session.playerX.split('@')[0]}\n⭕ Pemain 2: @${res.session.playerO.split('@')[0]}\n\n${games.renderBoard(res.session.board)}\nGiliran: @${res.session.turn.split('@')[0]} (Ketik angka 1-9)`,
        mentions: [res.session.playerX, res.session.playerO]
      });
    }

    const startRes = games.startTTT(chatId, sender);
    if (!startRes.status) return reply(startRes.message);

    return await sock.sendMessage(chatId, {
      text: `🎮 *TicTacToe Room Dibuat!*\n\nMenunggu lawan... Lawan silakan ketik:\n👉 *.tictactoe join* (atau *.ttt join*)\n\n${games.renderBoard(startRes.session.board)}`
    });
  }

  if (command === 'delttt') {
    const deleted = games.deleteTTT(chatId);
    if (deleted) return reply('✅ Sesi permainan TicTacToe di chat ini berhasil dihapus.');
    return reply('Tidak ada sesi TicTacToe yang aktif di chat ini.');
  }

  if (command === 'math') {
    const mathProb = games.generateMathProblem();
    const points = 150;

    games.quizSessions.set(chatId, {
      answer: mathProb.answer,
      points,
      type: 'math',
      timer: setTimeout(() => {
        if (games.quizSessions.has(chatId)) {
          games.quizSessions.delete(chatId);
          sock.sendMessage(chatId, { text: `⏰ *Waktu habis!* Jawaban kuis matematika adalah: *${mathProb.answer}*` });
        }
      }, 45000)
    });

    return reply(`🧮 *KUIS MATEMATIKA*\n\nBerapakah hasil dari:\n👉 *${mathProb.question} = ?*\n\n⏱️ Waktu: 45 Detik\n🪙 Hadiah: +${points} Koin`);
  }

  if (command === 'ppt' || command === 'suit') {
    if (!q) return reply(`Pilih tanganmu!\nContoh: *${config.prefix}suit batu* (atau gunting / kertas)`);
    const res = games.playSuit(q);
    if (!res.status) return reply(res.message);

    let caption = `✊✌️✋ *SUIT (BATU GUNTING KERTAS)*\n\n` +
      `👤 Kamu : ${res.userChoice}\n` +
      `🤖 Bot  : ${res.botChoice}\n\n`;

    if (res.result === 'MENANG') {
      caption += `🎉 *KAMU MENANG!* Selamat!`;
      db.updateUser(sender, (u) => { u.balance = (u.balance || 0) + 50; });
    } else if (res.result === 'KALAH') {
      caption += `😢 *KAMU KALAH!* Coba lagi ya.`;
    } else {
      caption += `🤝 *SERI!* Permainan seimbang.`;
    }
    return reply(caption);
  }

  if (command === 'slot') {
    const res = games.spinSlot();
    let text = `🎰 *MESIN SLOT VIRTUAL*\n\n` +
      `[ ${res.reels.join(' | ')} ]\n\n`;

    if (res.win) {
      const prize = Math.floor(100 * res.multiplier);
      text += `🎉 *JACKPOT WIN!* (x${res.multiplier})\n🪙 Hadiah: +${prize} Koin!`;
      db.updateUser(sender, (u) => { u.balance = (u.balance || 0) + prize; });
    } else {
      text += `😢 *Belum beruntung!* Silakan putar lagi.`;
    }
    return reply(text);
  }

  if (command === 'casino') {
    const bet = parseInt(args[0]) || 50;
    const user = db.getUser(sender);
    if ((user.balance || 0) < bet) return reply(`Koin Anda tidak cukup! Koin Anda saat ini: ${user.balance || 0} 🪙`);

    const win = Math.random() > 0.52;
    if (win) {
      const reward = bet * 2;
      db.updateUser(sender, (u) => { u.balance += bet; });
      return reply(`🎲 *CASINO WIN!*\n\nAnda bertaruh ${bet} koin dan menang!\nSaldo Anda bertambah +${reward} koin 🪙`);
    } else {
      db.updateUser(sender, (u) => { u.balance -= bet; });
      return reply(`🎲 *CASINO LOSE!*\n\nAnda kehilangan ${bet} koin. Jangan berkecil hati! 😢`);
    }
  }

  if (command === 'yourmom') {
    return reply(`👩 *Jokes Yo Mama*\n\n"${games.getYourMomJoke()}"`);
  }

  if (command === 'teri') {
    return reply(`📢 *WKWKWK AAAAAAAARRRGHHHH!* 🦖💥 (Teriakan Mengguncang Jiwa!)`);
  }

  if (command === 'tebakgambar') {
    const list = games.getTebakGambarList();
    const item = list[Math.floor(Math.random() * list.length)];
    const points = 200;

    games.quizSessions.set(chatId, {
      answer: item.answer,
      points,
      type: 'tebakgambar',
      timer: setTimeout(() => {
        if (games.quizSessions.has(chatId)) {
          games.quizSessions.delete(chatId);
          sock.sendMessage(chatId, { text: `⏰ *Waktu Habis!* Jawaban Tebak Gambar adalah: *${item.answer}*` });
        }
      }, 60000)
    });

    return await sock.sendMessage(chatId, {
      image: { url: item.image },
      caption: `🖼️ *KUIS TEBAK GAMBAR*\n\nPetunjuk: *${item.clue}*\n⏱️ Waktu: 60 detik\n🪙 Hadiah: +${points} koin\n_Ketik langsung jawabanmu di chat!_`
    }, { quoted: msg });
  }

  if (command === 'tebakkata') {
    const list = games.getTebakKataList();
    const item = list[Math.floor(Math.random() * list.length)];
    const points = 150;

    games.quizSessions.set(chatId, {
      answer: item.answer,
      points,
      type: 'tebakkata',
      timer: setTimeout(() => {
        if (games.quizSessions.has(chatId)) {
          games.quizSessions.delete(chatId);
          sock.sendMessage(chatId, { text: `⏰ *Waktu Habis!* Jawaban Tebak Kata adalah: *${item.answer}*` });
        }
      }, 60000)
    });

    return reply(`📝 *KUIS TEBAK KATA*\n\nClue: *${item.clue}*\n⏱️ Waktu: 60 Detik\n🪙 Hadiah: +${points} Koin\n_Ketik langsung jawabanmu di chat!_`);
  }

  if (command === 'coinflip') {
    return reply(`🪙 *Lempar Koin:*\nHasil: *${games.getCoinFlip()}*`);
  }

  if (command === 'dadu') {
    return reply(`🎲 *Lempar Dadu:*\nKeluar: *${games.getDice()}*`);
  }

  /* ====================================================================
   * 5. 🧩 STICKER
   * ==================================================================== */
  if (command === 'sticker') {
    const targetImage = rawMessage?.imageMessage || quotedMessage?.imageMessage;
    const targetVideo = rawMessage?.videoMessage || quotedMessage?.videoMessage;

    if (!targetImage && !targetVideo) {
      return reply(`Kirim gambar/video dengan caption *${config.prefix}sticker* atau balas gambar/video yang sudah dikirim!`);
    }

    await reply('⏳ Sedang memproses stiker...');
    try {
      const isVideo = Boolean(targetVideo);
      const mediaObj = isVideo ? targetVideo : targetImage;
      const buffer = await getMediaBuffer(mediaObj, isVideo ? 'video' : 'image');
      const stickerWebp = await mediaToWebp(buffer, isVideo, config.sticker.packname, config.sticker.author);

      await sock.sendMessage(chatId, { sticker: stickerWebp }, { quoted: msg });
    } catch (e) {
      reply(`❌ Gagal membuat stiker: ${e.message}`);
    }
    return;
  }

  if (command === 'take') {
    const targetSticker = quotedMessage?.stickerMessage;
    if (!targetSticker) {
      return reply(`Balas stiker dengan perintah *${config.prefix}take <packname> | <author>*\nContoh: *${config.prefix}take SikanBot | Rahmat Haikal*`);
    }
    await reply('⏳ Mengubah watermark stiker...');
    try {
      const parts = q.split('|').map((s) => s.trim());
      const pack = parts[0] || config.sticker.packname;
      const author = parts[1] || config.sticker.author;

      const buffer = await getMediaBuffer(targetSticker, 'sticker');
      const newSticker = await mediaToWebp(buffer, false, pack, author);
      await sock.sendMessage(chatId, { sticker: newSticker }, { quoted: msg });
    } catch (e) {
      reply(`❌ Gagal mengubah stiker: ${e.message}`);
    }
    return;
  }

  if (command === 'smaker') {
    if (!q) return reply(`Masukkan teks stiker!\nContoh: *${config.prefix}smaker Halo Dunia*`);
    await reply('⏳ Membuat stiker teks...');
    try {
      const stk = await createTextSticker(q, config.sticker.packname, config.sticker.author);
      await sock.sendMessage(chatId, { sticker: stk }, { quoted: msg });
    } catch (e) {
      reply(`❌ Gagal: ${e.message}`);
    }
    return;
  }

  if (command === 'getsticker') {
    if (!q) return reply(`Masukkan kata kunci stiker!\nContoh: *${config.prefix}getsticker spongebob*`);
    await reply('🔍 Mencari stiker...');
    try {
      const pins = await scraper.searchPinterest(q + ' sticker transparent');
      if (pins.length > 0) {
        const imgUrl = pins[0].image;
        const res = await scraper.axios.get(imgUrl, { responseType: 'arraybuffer' });
        const stk = await mediaToWebp(res.data, false, config.sticker.packname, config.sticker.author);
        await sock.sendMessage(chatId, { sticker: stk }, { quoted: msg });
      } else {
        reply('❌ Stiker tidak ditemukan.');
      }
    } catch (e) {
      reply(`❌ Gagal mencari stiker: ${e.message}`);
    }
    return;
  }

  if (command === 'emix') {
    if (!q) return reply(`Masukkan 2 emoji!\nContoh: *${config.prefix}emix 😭 😎*`);
    const emojis = q.match(/\p{Emoji}/gu) || [];
    if (emojis.length < 2) return reply('Harap masukkan minimal 2 emoji!');

    await reply('⏳ Menggabungkan emoji...');
    try {
      const mixUrl = await scraper.getEmojiMix(emojis[0], emojis[1]);
      const res = await scraper.axios.get(mixUrl, { responseType: 'arraybuffer' });
      const stk = await mediaToWebp(res.data, false, config.sticker.packname, config.sticker.author);
      await sock.sendMessage(chatId, { sticker: stk }, { quoted: msg });
    } catch (e) {
      reply(`❌ Gagal menggabungkan emoji: ${e.message}`);
    }
    return;
  }

  if (command === 'toimg') {
    const targetSticker = rawMessage?.stickerMessage || quotedMessage?.stickerMessage;
    if (!targetSticker) {
      return reply(`Balas stiker atau kirim stiker dengan caption *${config.prefix}toimg* untuk membukanya menjadi gambar!`);
    }
    await reply('⏳ Membuka stiker menjadi gambar...');
    try {
      const buffer = await getMediaBuffer(targetSticker, 'sticker');
      const imgBuffer = await webpToImage(buffer);
      await sock.sendMessage(chatId, { image: imgBuffer, caption: '✅ Stiker berhasil dibuka menjadi gambar!' }, { quoted: msg });
    } catch (e) {
      reply(`❌ Gagal membuka stiker: ${e.message}`);
    }
    return;
  }

  if (command === 'tovid') {
    const targetSticker = rawMessage?.stickerMessage || quotedMessage?.stickerMessage;
    if (!targetSticker) {
      return reply(`Balas stiker animasi (bergerak) dengan *${config.prefix}tovid* untuk mengubahnya menjadi video!`);
    }
    await reply('⏳ Mengonversi stiker animasi ke video MP4...');
    try {
      const buffer = await getMediaBuffer(targetSticker, 'sticker');
      const vidBuffer = await webpToVideo(buffer);
      await sock.sendMessage(chatId, { video: vidBuffer, caption: '✅ Berhasil diubah ke video.', mimetype: 'video/mp4' }, { quoted: msg });
    } catch (e) {
      reply(`❌ Gagal konversi: ${e.message}`);
    }
    return;
  }

  if (command === 'attp') {
    if (!q) return reply(`Masukkan teks untuk stiker animasi berkelip!\nContoh: *${config.prefix}attp SikanBot*`);
    await reply('⏳ Membuat stiker animasi teks (ATTP)...');
    try {
      const attpWebp = await createAttpSticker(q, config.sticker.packname, config.sticker.author);
      await sock.sendMessage(chatId, { sticker: attpWebp }, { quoted: msg });
    } catch (e) {
      reply(`❌ Gagal membuat ATTP: ${e.message}`);
    }
    return;
  }

  if (command === 'brat') {
    if (!q) return reply(`Masukkan teks untuk stiker brat!\nContoh: *${config.prefix}brat sikanbot*`);
    await reply('⏳ Membuat stiker brat...');
    try {
      const bratSticker = await createBratSticker(q, config.sticker.packname, config.sticker.author);
      await sock.sendMessage(chatId, { sticker: bratSticker }, { quoted: msg });
    } catch (e) {
      reply(`❌ Gagal membuat stiker brat: ${e.message}`);
    }
    return;
  }

  /* ====================================================================
   * 6. 🛠️ TOOLS
   * ==================================================================== */
  if (command === 'calc') {
    if (!q) return reply(`Masukkan perhitungan matematika!\nContoh: *${config.prefix}calc 25 * 4 + (100 / 2)*`);
    try {
      const sanitized = q.replace(/[^0-9+\-*/().%^ ]/g, '');
      const result = Function(`'use strict'; return (${sanitized})`)();
      return reply(`🧮 *KALKULATOR*\n\n• Soal : ${sanitized}\n• Hasil: *${result}*`);
    } catch (e) {
      return reply('❌ Format perhitungan tidak valid.');
    }
  }

  if (command === 'pdf') {
    if (!q) return reply(`Masukkan teks atau materi yang ingin dijadikan PDF!\nContoh: *${config.prefix}pdf Judul Materi\nIni adalah isi catatan saya...*`);
    await reply('⏳ Membuat file PDF...');
    try {
      const pdfBuffer = await scraper.createPdfFromText(q, 'Dokumen SikanBot');
      await sock.sendMessage(chatId, {
        document: pdfBuffer,
        mimetype: 'application/pdf',
        fileName: `Dokumen_${Date.now()}.pdf`,
        caption: '✅ File PDF berhasil dibuat!'
      }, { quoted: msg });
    } catch (e) {
      reply(`❌ Gagal membuat PDF: ${e.message}`);
    }
    return;
  }

  if (command === 'qrcode') {
    if (!q) return reply(`Masukkan teks atau link URL untuk dijadikan QR Code!\nContoh: *${config.prefix}qrcode https://google.com*`);
    await reply('⏳ Membuat QR Code...');
    try {
      const qrBuffer = await scraper.createQrCode(q);
      await sock.sendMessage(chatId, {
        image: qrBuffer,
        caption: `📱 *QR Code Generator*\n\nKonten: ${q}`
      }, { quoted: msg });
    } catch (e) {
      reply(`❌ Gagal membuat QR Code: ${e.message}`);
    }
    return;
  }

  if (command === 'shorturl') {
    if (!q) return reply(`Masukkan URL yang ingin diperpendek!\nContoh: *${config.prefix}shorturl https://contoh-link-panjang.com*`);
    try {
      const short = await scraper.shortenUrl(q);
      return reply(`🔗 *Pemendek URL (TinyURL)*\n\n• Asli : ${q}\n• Hasil: *${short}*`);
    } catch (e) {
      return reply(`❌ Gagal: ${e.message}`);
    }
  }

  if (command === 'translate') {
    if (!q) return reply(`Masukkan bahasa tujuan dan teks!\nContoh: *${config.prefix}translate en Selamat pagi dunia* atau *${config.prefix}tr id Good morning*`);
    let lang = 'id';
    let textToTrans = q;
    if (args.length > 1 && args[0].length === 2) {
      lang = args[0];
      textToTrans = args.slice(1).join(' ');
    }
    await reply('⏳ Menerjemahkan...');
    try {
      const res = await scraper.translateText(textToTrans, lang);
      return reply(`🌐 *TRANSLATE (${lang.toUpperCase()})*\n\n${res}`);
    } catch (e) {
      return reply(`❌ Gagal menerjemahkan: ${e.message}`);
    }
  }

  if (command === 'ssweb') {
    if (!q) return reply(`Masukkan URL website!\nContoh: *${config.prefix}ssweb https://google.com*`);
    await reply('📸 Mengambil screenshot website...');
    try {
      const ssUrl = scraper.getWebScreenshotUrl(q);
      await sock.sendMessage(chatId, {
        image: { url: ssUrl },
        caption: `🖥️ *Screenshot Website:* ${q}`
      }, { quoted: msg });
    } catch (e) {
      reply(`❌ Gagal mengambil screenshot: ${e.message}`);
    }
    return;
  }

  if (command === 'ocr') {
    const targetImage = rawMessage?.imageMessage || quotedMessage?.imageMessage;
    if (!targetImage) {
      return reply(`Kirim atau balas gambar bertuliskan teks dengan perintah *${config.prefix}ocr*!`);
    }

    await reply('🔍 Membaca dan mengekstrak teks dari gambar...');
    try {
      const imgBuffer = await getMediaBuffer(targetImage, 'image');
      const textResult = await scraper.getOCR(imgBuffer);
      return reply(`📄 *HASIL OCR (EKSTRAKSI TEKS)*\n\n${textResult}`);
    } catch (e) {
      return reply(`❌ ${e.message}`);
    }
  }

  if (command === 'weather') {
    if (!q) return reply(`Masukkan nama kota!\nContoh: *${config.prefix}weather Lhokseumawe*`);
    await reply('🌤️ Mengecek prakiraan cuaca...');
    try {
      const w = await scraper.getWeather(q);
      return reply(`🌤️ *INFO CUACA KOTA*\n\n` +
        `📍 *Lokasi:* ${w.location}\n` +
        `🌡️ *Suhu:* ${w.tempC}°C (Terasa seperti ${w.feelsLikeC}°C)\n` +
        `☁️ *Kondisi:* ${w.condition}\n` +
        `💧 *Kelembapan:* ${w.humidity}%\n` +
        `💨 *Kecepatan Angin:* ${w.windSpeed} km/h\n` +
        `☀️ *Indeks UV:* ${w.uvIndex}`);
    } catch (e) {
      return reply(`❌ ${e.message}`);
    }
  }

  /* ====================================================================
   * 7. 👥 GROUP (Admin & Moderasi)
   * ==================================================================== */
  if (['add', 'kick', 'promote', 'demote', 'tagall', 'hidetag', 'groupinfo', 'linkgroup', 'revoke', 'open', 'close', 'warn', 'antilink', 'antispam', 'welcome'].includes(command)) {
    if (!isGroup) return reply('Perintah ini hanya dapat digunakan di dalam grup!');

    if (command === 'groupinfo') {
      const info = `👥 *INFORMASI GRUP*\n\n` +
        `• *Nama Grup:* ${groupName}\n` +
        `• *ID Grup:* ${chatId}\n` +
        `• *Total Anggota:* ${groupMembers.length}\n` +
        `• *Admin:* ${groupAdmins.length}\n` +
        `• *Status Bot:* ${isBotAdmin ? '👑 Admin' : 'Anggota Biasa'}\n` +
        `• *Anti Link:* ${db.getGroup(chatId).antilink ? '🟢 ON' : '🔴 OFF'}\n` +
        `• *Anti Spam:* ${db.getGroup(chatId).antispam ? '🟢 ON' : '🔴 OFF'}\n` +
        `• *Welcome:* ${db.getGroup(chatId).welcome ? '🟢 ON' : '🔴 OFF'}`;
      return reply(info);
    }

    if (!isAdmin && !isOwner) {
      return reply('❌ Perintah ini hanya bisa digunakan oleh Admin Grup!');
    }

    if (command === 'tagall') {
      let text = `📢 *TAG ALL MEMBERS*\n${q ? `Pesan: *${q}*\n` : ''}\n`;
      const mentions = [];
      groupMembers.forEach((m, i) => {
        text += `${i + 1}. @${m.id.split('@')[0]}\n`;
        mentions.push(m.id);
      });
      return await sock.sendMessage(chatId, { text, mentions });
    }

    if (command === 'hidetag') {
      const text = q || '📢 PENGUMUMAN GRUP';
      const mentions = groupMembers.map((m) => m.id);
      return await sock.sendMessage(chatId, { text, mentions });
    }

    if (command === 'open') {
      if (!isBotAdmin) return reply('❌ Bot harus menjadi Admin untuk membuka grup!');
      await sock.groupSettingUpdate(chatId, 'not_announcement');
      return reply('🔓 Grup telah dibuka! Semua anggota dapat mengirim pesan.');
    }

    if (command === 'close') {
      if (!isBotAdmin) return reply('❌ Bot harus menjadi Admin untuk menutup grup!');
      await sock.groupSettingUpdate(chatId, 'announcement');
      return reply('🔒 Grup telah ditutup! Hanya admin yang dapat mengirim pesan.');
    }

    if (command === 'linkgroup') {
      if (!isBotAdmin) return reply('❌ Bot harus menjadi Admin untuk mengambil tautan undangan!');
      try {
        const code = await sock.groupInviteCode(chatId);
        return reply(`🔗 *Tautan Undangan Grup:*\nhttps://chat.whatsapp.com/${code}`);
      } catch (e) {
        return reply('Gagal mengambil tautan undangan.');
      }
    }

    if (command === 'revoke') {
      if (!isBotAdmin) return reply('❌ Bot harus menjadi Admin untuk mereset link undangan!');
      try {
        await sock.groupRevokeInvite(chatId);
        return reply('✅ Tautan undangan grup berhasil direset.');
      } catch (e) {
        return reply('Gagal mereset tautan undangan.');
      }
    }

    if (command === 'antilink') {
      const val = !db.getGroup(chatId).antilink;
      db.updateGroup(chatId, { antilink: val });
      return reply(`🛡️ *Anti Link* sekarang telah di-${val ? 'AKTIFKAN 🟢' : 'NONAKTIFKAN 🔴'}`);
    }

    if (command === 'antispam') {
      const val = !db.getGroup(chatId).antispam;
      db.updateGroup(chatId, { antispam: val });
      return reply(`🛡️ *Anti Spam* sekarang telah di-${val ? 'AKTIFKAN 🟢' : 'NONAKTIFKAN 🔴'}`);
    }

    if (command === 'welcome') {
      const val = !db.getGroup(chatId).welcome;
      db.updateGroup(chatId, { welcome: val });
      return reply(`👋 *Pesan Welcome* sekarang telah di-${val ? 'AKTIFKAN 🟢' : 'NONAKTIFKAN 🔴'}`);
    }

    if (command === 'warn') {
      const target = msg.message?.extendedTextMessage?.contextInfo?.participant
        || (args[0] ? args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : null);
      if (!target) return reply('Balas pesan member atau sebut nomornya!');

      const user = db.getUser(target);
      const warns = (user.warns || 0) + 1;
      db.updateUser(target, { warns });

      if (warns >= 3) {
        db.updateUser(target, { warns: 0 });
        if (isBotAdmin) {
          await sock.groupParticipantsUpdate(chatId, [target], 'remove');
          return reply(`⚠️ @${target.split('@')[0]} telah menerima 3 peringatan dan dikeluarkan dari grup!`, { mentions: [target] });
        } else {
          return reply(`⚠️ @${target.split('@')[0]} telah menerima 3 peringatan (Bot bukan admin untuk kick).`, { mentions: [target] });
        }
      } else {
        return reply(`⚠️ Peringatan untuk @${target.split('@')[0]} (${warns}/3). Hati-hati!`, { mentions: [target] });
      }
    }

    if (!isBotAdmin) return reply('❌ Bot harus menjadi Admin untuk melakukan aksi ini!');

    const target = msg.message?.extendedTextMessage?.contextInfo?.participant
      || (args[0] ? args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : null);

    if (!target) return reply('Balas pesan member yang dituju atau masukkan nomornya!');

    if (command === 'kick') {
      await sock.groupParticipantsUpdate(chatId, [target], 'remove');
      return reply(`👢 Berhasil mengeluarkan @${target.split('@')[0]} dari grup.`, { mentions: [target] });
    }

    if (command === 'add') {
      await sock.groupParticipantsUpdate(chatId, [target], 'add');
      return reply(`✅ Berhasil menambahkan @${target.split('@')[0]} ke grup.`, { mentions: [target] });
    }

    if (command === 'promote') {
      await sock.groupParticipantsUpdate(chatId, [target], 'promote');
      return reply(`👑 @${target.split('@')[0]} sekarang menjadi Admin Grup!`, { mentions: [target] });
    }

    if (command === 'demote') {
      await sock.groupParticipantsUpdate(chatId, [target], 'demote');
      return reply(`📉 @${target.split('@')[0]} telah diturunkan menjadi member biasa.`, { mentions: [target] });
    }
  }

  /* ====================================================================
   * 8. 👑 OWNER
   * ==================================================================== */
  if (['addprem', 'delprem', 'listprem', 'ban', 'unban', 'block', 'unblock', 'broadcast', 'join', 'leave', 'restart', 'shutdown'].includes(command)) {
    if (!isOwner) return reply('❌ Perintah ini khusus untuk *Owner Bot (Rahmat Haikal)*!');

    if (command === 'addprem') {
      const target = args[0] ? args[0].replace(/[^0-9]/g, '') : '';
      if (!target) return reply(`Masukkan nomor user!\nContoh: *${config.prefix}addprem 62822xxx*`);
      db.updateUser(target, { premium: true });
      return reply(`⭐ User @${target} berhasil ditambahkan ke daftar Premium!`);
    }

    if (command === 'delprem') {
      const target = args[0] ? args[0].replace(/[^0-9]/g, '') : '';
      if (!target) return reply(`Masukkan nomor user!\nContoh: *${config.prefix}delprem 62822xxx*`);
      db.updateUser(target, { premium: false });
      return reply(`User @${target} telah dihapus dari Premium.`);
    }

    if (command === 'listprem') {
      const users = db.data.users || {};
      const prems = Object.keys(users).filter((k) => users[k].premium);
      if (prems.length === 0) return reply('Belum ada user premium.');
      let out = `👑 *DAFTAR USER PREMIUM (${prems.length})*\n\n`;
      prems.forEach((p, i) => { out += `${i + 1}. @${p}\n`; });
      return reply(out);
    }

    if (command === 'ban') {
      const target = args[0] ? args[0].replace(/[^0-9]/g, '') : '';
      if (!target) return reply(`Masukkan nomor yang ingin diban!\nContoh: *${config.prefix}ban 628xxx*`);
      db.updateUser(target, { banned: true });
      return reply(`🚫 User @${target} telah dibanned dari bot!`);
    }

    if (command === 'unban') {
      const target = args[0] ? args[0].replace(/[^0-9]/g, '') : '';
      if (!target) return reply(`Masukkan nomor yang ingin di-unban!\nContoh: *${config.prefix}unban 628xxx*`);
      db.updateUser(target, { banned: false });
      return reply(`✅ User @${target} telah di-unban.`);
    }

    if (command === 'block') {
      const target = args[0] ? args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : chatId;
      await sock.updateBlockStatus(target, 'block');
      return reply(`🚫 Nomor @${target.split('@')[0]} berhasil diblokir oleh bot.`);
    }

    if (command === 'unblock') {
      const target = args[0] ? args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : chatId;
      await sock.updateBlockStatus(target, 'unblock');
      return reply(`✅ Nomor @${target.split('@')[0]} berhasil dibuka blokirnya.`);
    }

    if (command === 'broadcast') {
      if (!q) return reply(`Masukkan pesan siaran!\nContoh: *${config.prefix}bc Halo semua pengguna SikanBot!*`);
      await reply('📢 Memulai siaran pesan ke seluruh grup...');
      try {
        const allGroups = await sock.groupFetchAllParticipating();
        const list = Object.keys(allGroups);
        let count = 0;
        for (const gId of list) {
          try {
            await sock.sendMessage(gId, {
              text: `📢 *SIARAN OWNER (BROADCAST)*\n\n${q}\n\n_Pesan resmi dari ${config.owner.name}_`
            });
            count++;
            await new Promise((r) => setTimeout(r, 1000));
          } catch (_) { }
        }
        return reply(`✅ Siaran berhasil terkirim ke ${count} grup!`);
      } catch (e) {
        return reply(`❌ Gagal broadcast: ${e.message}`);
      }
    }

    if (command === 'join') {
      if (!q) return reply(`Masukkan link undangan grup!\nContoh: *${config.prefix}join https://chat.whatsapp.com/...*`);
      const code = q.replace(/https?:\/\/chat\.whatsapp\.com\//i, '').trim();
      try {
        await sock.groupAcceptInvite(code);
        return reply('✅ Berhasil bergabung ke grup!');
      } catch (e) {
        return reply(`❌ Gagal bergabung: ${e.message}`);
      }
    }

    if (command === 'leave') {
      if (!isGroup) return reply('Perintah ini hanya bisa dijalankan di dalam grup!');
      await reply('👋 Selamat tinggal semuanya! SikanBot izin undur diri.');
      return await sock.groupLeave(chatId);
    }

    if (command === 'restart') {
      await reply('🔄 Merestart sistem SikanBot...');
      setTimeout(() => { process.exit(0); }, 1000);
      return;
    }

    if (command === 'shutdown') {
      await reply('🛑 Mematikan SikanBot...');
      setTimeout(() => { process.exit(0); }, 1000);
      return;
    }
  }

  /* ====================================================================
   * 9. 🤖 AI
   * ==================================================================== */
  if (command === 'ai' || command === 'ask') {
    if (!q) return reply(`Halo! Tanyakan apa saja kepada AI.\nContoh: *${config.prefix}ai Jelaskan cara kerja jaringan internet secara sederhana*`);
    await reply('🤖 SikanBot AI sedang berpikir...');
    try {
      const answer = await scraper.askAI(q);
      return reply(answer);
    } catch (e) {
      return reply(`❌ ${e.message}`);
    }
  }

  if (command === 'imagine') {
    if (!q) return reply(`Masukkan prompt deskripsi gambar!\nContoh: *${config.prefix}imagine cybernetic futuristic cat with neon lights, 4k ultra detailed*`);
    await reply('🎨 Sedang melukis gambar dengan AI...');
    try {
      const imgUrl = scraper.getImagineUrl(q);
      await sock.sendMessage(chatId, {
        image: { url: imgUrl },
        caption: `✨ *AI Image Generator*\n\nPrompt: _${q}_\nGenerated by *SikanBot*`
      }, { quoted: msg });
    } catch (e) {
      reply(`❌ Gagal membuat gambar: ${e.message}`);
    }
    return;
  }

  if (command === 'summarize') {
    const textToSum = q || (quoted ? (quoted.conversation || quoted.extendedTextMessage?.text) : '');
    if (!textToSum) return reply(`Kirim atau balas teks panjang yang ingin dirangkum!\nContoh: *${config.prefix}summarize <artikel>*`);
    await reply('📝 Merangkum teks...');
    try {
      const summary = await scraper.askAI(textToSum, 'Tolong buat rangkuman inti poin penting yang padat, jelas, dan rapi dalam bahasa Indonesia.');
      return reply(`📑 *RANGKUMAN TEKS*\n\n${summary}`);
    } catch (e) {
      return reply(`❌ Gagal merangkum: ${e.message}`);
    }
  }
}

module.exports = {
  handleMessage
};
