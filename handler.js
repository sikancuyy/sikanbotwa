const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { downloadContentFromMessage, jidNormalizedUser, areJidsSameUser } = require('@whiskeysockets/baileys');
const config = require('./config');
const db = require('./lib/database');
const userDb = require('./database/users');
const games = require('./lib/games');
const scraper = require('./lib/scraper');
const { mediaToWebp, webpToImage, webpToVideo, createAttpSticker, createTextSticker, createBratSticker, createBratVideoSticker } = require('./lib/sticker');
const { formatBytes, formatUptime, log, deleteFileSafe } = require('./utils');
const { downloadVideo, downloadAudio } = require('./downloader');
const { checkUserLimit, consumeUserLimit, formatUserStatus } = require('./helpers/limit');
const { getValidGroupParticipants, filterActiveMentions, isGroupAdmin, isBotAdmin, formatKickMessage, groupCache, getGroupMetadataSafe } = require('./helpers/group');
const { generateTTS, convertToVoiceNote, cleanTempAudio } = require('./helpers/tts');
const { generateQuoteChat, generateBratCustom, generateBratPc, generateStickerMeme, generateTTP, searchStickerly, searchTenor, getTelegramStickers, getRandomRyo } = require('./helpers/mediaHelper');
const {
  startProcessing,
  stopProcessing,
  startTyping,
  stopTyping,
  setReaction,
  setProcessingReaction
} = require('./helpers/processingStatus');
const {
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
} = require('./helpers/menus');
const {
  getRealPhoneNumber,
  isValidPhoneNumber,
  normalizePhoneNumber,
  formatPhoneDisplay,
  resolveLidToPhone,
  getQuotedPhoneNumber,
  getUserJid,
  getUserNumber,
  getQuotedUserNumber,
  normalizeUserNumber,
  isValidUserNumber
} = require('./helpers/userHelper');
const {
  markMessageSent,
  isDuplicateMessage,
  isOldMessage,
  clearDeduplicationCache
} = require('./helpers/messageDeduplicator');

// Daftar seluruh command valid bot
const VALID_COMMANDS = new Set([
  // Bot Menu Utama & Submenu Kategori
  'menu', 'help', 'start', 'in', 'ins', 'inmenu', 'indownload', 'indw', 'insearch', 'inscr', 'ingame', 'ingm',
  'insticker', 'intts', 'inuser', 'intools', 'intl', 'ingroup', 'ingr', 'inadmin', 'inadm', 'inai', 'ininfo', 'inlog',

  // Bot Menu & Info
  'ping', 'alive', 'uptime', 'runtime', 'bot', 'infobot',
  'owner', 'script', 'donate', 'groups', 'blocklist', 'stats',

  // User & Limit & Database
  'limit', 'ceklimit', 'me', 'daftar', 'register', 'premium', 'sewa', 'sewabot',

  // Admin DB & User Management & Logs
  'users', 'listuser', 'infouser', 'userinfo', 'resetlimit', 'setunlimited', 'setlimit',
  'addadmin', 'deladmin', 'listadmin', 'daftaruser', 'deluser',
  'logs', 'loguser', 'logcmd', 'logerror', 'logdownload', 'loggroup',

  // Download
  'play', 'play2', 'ytm', 'ytmp3', 'yts', 'tiktok', 'tiktokfoto', 'tiktokstalk',
  'tiktokmusic', 'tiktokmusik', 'ttmusik', 'ttmusic', 'ttmp3', 'tiktokmp3', 'ttm',
  'ig', 'igstory', 'twitter', 'gitclone',

  // Search
  'google',

  // Game & Fun
  'tictactoe', 'delttt', 'math', 'ppt', 'suit', 'slot', 'casino',
  'yourmom', 'teri', 'tebakgambar', 'tebakkata', 'coinflip', 'dadu',

  // Sticker & Media
  'sticker', 'take', 'smaker', 'getsticker', 'emix', 'toimg', 'tovid',
  'attp', 'ttp', 'brat', 'bratpc', 'bratcolor', 'brathd', 'bratvid', 'bratvid2',
  'brat2', 'brat3', 'anyabrat', 'animebrat', 'animebrat2', 'qc', 'qc2',
  'smeme', 'emojigif', 'gifsticker', 'stly', 'stickerlysearch',
  'telestick', 'tenor', 'stickersearch', 'ryo',

  // TTS
  'tts',

  // Tools
  'calc', 'qrcode', 'shorturl', 'translate', 'ssweb', 'ocr', 'weather', 'pdf', 'kan',

  // Group Management
  'antilink', 'antispam', 'welcome', 'groupinfo', 'linkgroup', 'revoke',
  'tagall', 'hidetag', 'kick', 'add', 'promote', 'demote', 'open', 'close',

  // Owner Commands
  'broadcast', 'join', 'leave', 'restart', 'shutdown',
  'addprem', 'delprem', 'listprem', 'ban', 'unban', 'block', 'unblock', 'warn',

  // AI
  'ai', 'ask', 'imagine', 'summarize'
]);

// Sesi percakapan registrasi user (.daftar)
const registrationSessions = new Map();

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
 * Ekstraksi informasi media View Once dari quoted message Baileys
 * Mendukung viewOnceMessage, viewOnceMessageV2, viewOnceMessageV2Extension, ephemeral, dan documentWithCaption
 */
function extractViewOnceMedia(rawQuoted) {
  if (!rawQuoted) return null;

  let current = rawQuoted;
  let isViewOnce = false;

  // Telusuri kemungkinan pembungkus (wrapper)
  let loopCount = 0;
  while (loopCount < 8 && current) {
    loopCount++;
    if (current.viewOnceMessage) {
      isViewOnce = true;
      current = current.viewOnceMessage.message || current.viewOnceMessage;
    } else if (current.viewOnceMessageV2) {
      isViewOnce = true;
      current = current.viewOnceMessageV2.message || current.viewOnceMessageV2;
    } else if (current.viewOnceMessageV2Extension) {
      isViewOnce = true;
      current = current.viewOnceMessageV2Extension.message || current.viewOnceMessageV2Extension;
    } else if (current.ephemeralMessage?.message) {
      current = current.ephemeralMessage.message;
    } else if (current.documentWithCaptionMessage?.message) {
      current = current.documentWithCaptionMessage.message;
    } else if (current.message) {
      current = current.message;
    } else {
      break;
    }
  }

  const imageMsg = current?.imageMessage;
  const videoMsg = current?.videoMessage;

  // Cek juga jika ada flag viewOnce: true pada properti media
  if (imageMsg?.viewOnce || videoMsg?.viewOnce) {
    isViewOnce = true;
  }

  if (!isViewOnce) {
    return { isViewOnce: false };
  }

  if (imageMsg) {
    return {
      isViewOnce: true,
      mediaType: 'image',
      mediaObj: imageMsg,
      caption: imageMsg.caption || '',
      mimetype: imageMsg.mimetype || 'image/jpeg'
    };
  }

  if (videoMsg) {
    return {
      isViewOnce: true,
      mediaType: 'video',
      mediaObj: videoMsg,
      caption: videoMsg.caption || '',
      mimetype: videoMsg.mimetype || 'video/mp4'
    };
  }

  return { isViewOnce: true, mediaType: null };
}


/**
 * Helper resolusi perintah menu bertingkat yang toleran terhadap typo / singkatan
 * (Contoh: .ins, .indown, .ingam, .insear, .in tools, .in, dll)
 */
function resolveTieredMenu(command, q = '') {
  if (!command) return null;
  // Lindungi perintah non-menu yang diawali 'in'
  if (['infobot', 'infouser', 'infogc', 'instagram', 'instastory'].includes(command)) {
    return null;
  }

  // Jika bukan diawali 'in' dan bukan 'ins'
  if (!command.startsWith('in')) {
    return null;
  }

  // Khusus 'ins' yang tertera di menu: langsung ke insticker
  if (command === 'ins') {
    return 'insticker';
  }

  // Jika persis 'in' dan ada parameter q, periksa kata pertama q
  let target = '';
  if (command === 'in') {
    target = (q || '').trim().toLowerCase().split(/\s+/)[0] || '';
  } else {
    // Ambil string setelah prefix 'in'
    target = command.slice(2).toLowerCase();
  }

  if (!target) {
    return 'inmenu';
  }

  // 1. Sticker (.ins, .insticker, .instik, .instk, .instiker, .instick, .in sticker)
  if (target === 's' || /^(stik|stick|stk)/.test(target)) {
    return 'insticker';
  }

  // 2. Download (.indownload, .indw, .indown, .indl, .inunduh, .in download)
  if (/^(dw|down|dl|unduh)/.test(target)) {
    return 'indownload';
  }

  // 3. Search (.insearch, .inscr, .insear, .incari, .insrch, .in search)
  if (/^(scr|sear|cari|srch)/.test(target)) {
    return 'insearch';
  }

  // 4. Game (.ingame, .ingm, .ingam, .inpermainan, .in game)
  if (/^(gm|gam|gem|permainan)/.test(target)) {
    return 'ingame';
  }

  // 5. TTS (.intts, .invoice, .insuara, .intt, .in tts)
  if (/^(tts|voice|suara)/.test(target)) {
    return 'intts';
  }

  // 6. User (.inuser, .inusr, .inprofil, .inakun, .in user)
  if (/^(us|profil|akun)/.test(target)) {
    return 'inuser';
  }

  // 7. Tools (.intools, .intl, .intool, .intul, .inalat, .in tools)
  if (/^(tl|tool|tul|alat)/.test(target)) {
    return 'intools';
  }

  // 8. Group (.ingroup, .ingr, .ingrup, .ingrp, .ingc, .in group)
  if (/^(gr|group|grup|grp|gc)/.test(target)) {
    return 'ingroup';
  }

  // 9. Admin (.inadmin, .inadmn, .inadm, .inowner, .in admin)
  if (/^(ad|owner|own)/.test(target)) {
    return 'inadmin';
  }

  // 10. AI (.inai, .ingpt, .inopenai, .in ai)
  if (/^(ai|gpt|openai|botai)/.test(target)) {
    return 'inai';
  }

  // 11. Info (.ininfo, .ininf, .ininformasi, .in info)
  if (/^(inf)/.test(target)) {
    return 'ininfo';
  }

  // 12. Log (.inlog, .inlogs, .inmonitoring, .in log)
  if (/^(log|monitoring)/.test(target)) {
    return 'inlog';
  }

  // 13. General / Menu (.inmenu, .inmen, .inmain, .inhelp, .in menu)
  if (/^(menu|main|help|awal)/.test(target)) {
    return 'inmenu';
  }

  // Fallback: Jika user mengetikkan perintah diawali 'in' apapun (misal .inxyz),
  // tetap arahkan masuk ke halaman menu bertingkat agar tidak gagal
  return 'inmenu';
}

/**
 * Handler utama pesan WhatsApp
 */
async function handleMessage(sock, msg, startTime) {
  if (!msg || !msg.message || msg.key?.remoteJid === 'status@broadcast') return;

  // Abaikan pesan reaction, protocol message (edit/delete/revoke), dan poll update
  if (
    msg.message.reactionMessage ||
    msg.message.protocolMessage ||
    msg.message.pollUpdateMessage
  ) {
    return;
  }

  // Abaikan pesan stale / antrean lama (misal saat reconnect setelah offline)
  if (isOldMessage(msg)) {
    return;
  }

  // Cek duplikasi pesan untuk mencegah eksekusi dan pengiriman ulang ganda
  if (isDuplicateMessage(msg)) {
    return;
  }

  const chatId = msg.key.remoteJid;
  msg.chat = chatId;
  let commandHasFailed = false;
  let lastCommandError = null;
  const cmdStartTime = Date.now();
  const isGroup = chatId.endsWith('@g.us');

  // SATU-SATUNYA SUMBER NOMOR HP: getRealPhoneNumber
  let userNumber = getRealPhoneNumber(msg, sock, null);
  if (!userNumber && (String(msg.key?.participant).includes('@lid') || String(msg.participant).includes('@lid') || String(chatId).includes('@lid'))) {
    if (isGroup) {
      const gm = await getGroupMetadataSafe(sock, chatId);
      userNumber = getRealPhoneNumber(msg, sock, gm);
    }
    // Jika masih belum terdeteksi (baik di DM maupun di grup), coba cari di seluruh groupCache
    if (!userNumber) {
      const lidCandidate = String(msg.key?.participant || msg.participant || chatId);
      userNumber = resolveLidToPhone(lidCandidate, sock, null);
    }
  }

  const senderNumber = userNumber; // Format standar '628xxxxxxxxxx' numerik murni atau null
  const botNumber = (sock.user?.id || '').split(':')[0].replace(/[^0-9]/g, '');
  const ownerNum = config.owner.number.replace(/[^0-9]/g, '');
  const allOwnerNumbers = Array.isArray(config.owner.numbers)
    ? config.owner.numbers.map((n) => n.replace(/[^0-9]/g, ''))
    : [ownerNum];

  const sender = userNumber
    ? `${userNumber}@s.whatsapp.net`
    : (msg.key.fromMe
      ? (botNumber ? `${botNumber}@s.whatsapp.net` : `${ownerNum}@s.whatsapp.net`)
      : (isGroup ? (msg.key.participant || msg.participant || '') : chatId));

  const pushName = msg.pushName || 'Kak';
  const isOwner = Boolean(msg.key.fromMe) ||
    (senderNumber && allOwnerNumbers.includes(senderNumber)) ||
    (botNumber && senderNumber === botNumber) ||
    (senderNumber && db.isOwner(senderNumber)) ||
    (sender ? db.isOwner(sender) : false);
  const isPrem = isOwner || (sender ? db.isPremium(sender) : false);
  const isBanned = isOwner ? false : (sender ? db.isBanned(sender) : false);

  // 1. Unwrap Baileys wrappers (ephemeralMessage, viewOnceMessage, viewOnceMessageV2, documentWithCaptionMessage)
  let rawMessage = msg.message;
  while (
    rawMessage?.ephemeralMessage ||
    rawMessage?.viewOnceMessage ||
    rawMessage?.viewOnceMessageV2 ||
    rawMessage?.viewOnceMessageV2Extension ||
    rawMessage?.documentWithCaptionMessage
  ) {
    rawMessage = (
      rawMessage.ephemeralMessage?.message ||
      rawMessage.viewOnceMessage?.message ||
      rawMessage.viewOnceMessageV2?.message ||
      rawMessage.viewOnceMessageV2Extension?.message ||
      rawMessage.documentWithCaptionMessage?.message
    );
  }

  // 2. Simpan Quoted Message asli sebelum unwrap (untuk fitur seperti KAN / RVO View Once)
  const contextInfo =
    rawMessage?.extendedTextMessage?.contextInfo ||
    rawMessage?.imageMessage?.contextInfo ||
    rawMessage?.videoMessage?.contextInfo ||
    rawMessage?.documentMessage?.contextInfo ||
    rawMessage?.buttonsResponseMessage?.contextInfo ||
    rawMessage?.templateButtonReplyMessage?.contextInfo ||
    msg.message?.extendedTextMessage?.contextInfo ||
    null;
  const rawQuotedMessage = contextInfo?.quotedMessage || null;
  let quotedMessage = rawQuotedMessage;
  while (
    quotedMessage?.ephemeralMessage ||
    quotedMessage?.viewOnceMessage ||
    quotedMessage?.viewOnceMessageV2 ||
    quotedMessage?.viewOnceMessageV2Extension ||
    quotedMessage?.documentWithCaptionMessage
  ) {
    quotedMessage = (
      quotedMessage.ephemeralMessage?.message ||
      quotedMessage.viewOnceMessage?.message ||
      quotedMessage.viewOnceMessageV2?.message ||
      quotedMessage.viewOnceMessageV2Extension?.message ||
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

  // Objek helper reply dengan auto-mention cerdas dan validasi member grup aktif
  const reply = async (text, options = {}) => {
    if (typeof text === 'string' && (text.trim().startsWith('❌') || text.trim().startsWith('🚫') || text.trim().startsWith('⚠️'))) {
      commandHasFailed = true;
      lastCommandError = text.replace(/^[❌🚫⚠️]\s*/, '').trim();
    }
    const opts = { ...options };
    if (!options.skipAutoMention) {
      const textMentions = (String(text).match(/@(\d+)/g) || []).map((v) => `${v.slice(1)}@s.whatsapp.net`);
      let combinedMentions = [...new Set([...(options.mentions || []), ...textMentions])];
      if (isGroup && Array.isArray(groupMembers) && groupMembers.length > 0) {
        combinedMentions = filterActiveMentions(combinedMentions, groupMembers.map((m) => m.id));
      }
      if (combinedMentions.length > 0) {
        opts.mentions = combinedMentions.map((j) => jidNormalizedUser(j));
      }
    } else if (options.mentions && Array.isArray(options.mentions)) {
      let safeMentions = options.mentions;
      if (isGroup && Array.isArray(groupMembers) && groupMembers.length > 0) {
        safeMentions = filterActiveMentions(safeMentions, groupMembers.map((m) => m.id));
      }
      if (safeMentions.length > 0) {
        opts.mentions = safeMentions.map((j) => jidNormalizedUser(j));
      } else {
        delete opts.mentions;
      }
    }
    delete opts.skipAutoMention;
    let res;
    try {
      res = await sock.sendMessage(chatId, { text, ...opts }, { quoted: msg });
    } catch (_) {
      res = await sock.sendMessage(chatId, { text, ...opts });
    }
    if (res?.key?.id) {
      markMessageSent(res.key.id);
    }
    return res;
  };

  // Helper kehadiran (WhatsApp typing presence dengan auto keep-alive & concurrency tracking)
  const setPresence = async (status) => {
    if (status === 'composing') {
      await startTyping(sock, chatId);
    } else {
      await stopTyping(sock, chatId);
    }
  };

  // Cek apakah user diblokir/banned
  if (isBanned && !isOwner) {
    if (body.startsWith(config.prefix)) {
      return reply('🚫 Akun Anda telah dibanned dari penggunaan *SikanBot*. Hubungi Owner untuk unban.');
    }
    return;
  }

  // Konfigurasi grup (Lazy loaded agar command biasa tidak tertahan network)
  const groupConfig = isGroup ? db.getGroup(chatId) : null;
  let groupMetadata = null;
  let groupName = 'Grup';
  let groupMembers = [];
  let groupAdmins = [];
  let isBotAdmin = false;
  let isAdmin = isOwner;
  let groupLoaded = false;
  let botId = '';
  let botLid = '';
  let botParticipant = null;

  const loadGroupInfo = async (forceRefresh = false) => {
    if (!isGroup) return;
    if (groupLoaded && !forceRefresh) return;
    groupLoaded = true;
    try {
      groupMetadata = await getGroupMetadataSafe(sock, chatId, forceRefresh);
      if (groupMetadata) {
        groupName = groupMetadata.subject || 'Grup';
        groupMembers = groupMetadata.participants || [];

        // Normalisasi identitas bot (ID utama, nomor telepon, dan LID multi-device)
        const me = sock.user || sock.authState?.creds?.me || {};
        botId = jidNormalizedUser(me.id || '');
        botLid = me.lid ? jidNormalizedUser(me.lid) : '';
        const botJid = me.jid ? jidNormalizedUser(me.jid) : '';

        // Helper cek apakah participant adalah bot
        const isBotParticipant = (m) => {
          if (!m) return false;
          const pId = m.id ? jidNormalizedUser(m.id) : '';
          const pLid = m.lid ? jidNormalizedUser(m.lid) : '';
          const pJid = m.jid ? jidNormalizedUser(m.jid) : '';

          if (botId && (areJidsSameUser(pId, botId) || (pJid && areJidsSameUser(pJid, botId)))) return true;
          if (botLid && (areJidsSameUser(pId, botLid) || (pLid && areJidsSameUser(pLid, botLid)))) return true;
          if (botJid && (areJidsSameUser(pId, botJid) || (pJid && areJidsSameUser(pJid, botJid)))) return true;
          if (botNumber) {
            const pNum = pId.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
            if (pNum && pNum === botNumber) return true;
          }
          return false;
        };

        // Helper cek apakah participant berstatus admin atau superadmin
        const checkIsAdmin = (m) => {
          if (!m) return false;
          return m.admin === 'admin' || m.admin === 'superadmin' || Boolean(m.isAdmin) || Boolean(m.isSuperAdmin);
        };

        const adminParticipants = groupMembers.filter(checkIsAdmin);
        groupAdmins = adminParticipants.map((m) => m.id);

        botParticipant = groupMembers.find(isBotParticipant) || null;
        isBotAdmin = Boolean(botParticipant && checkIsAdmin(botParticipant));

        // Debug log status bot admin
        console.log({
          botId,
          botParticipant,
          botAdminStatus: botParticipant?.admin
        });

        // Cek status sender apakah admin atau superadmin
        const senderParticipant = groupMembers.find((m) => {
          const pId = m.id ? jidNormalizedUser(m.id) : '';
          const pLid = m.lid ? jidNormalizedUser(m.lid) : '';
          const pJid = m.jid ? jidNormalizedUser(m.jid) : '';
          return (
            areJidsSameUser(pId, sender) ||
            (pJid && areJidsSameUser(pJid, sender)) ||
            (pLid && areJidsSameUser(pLid, sender)) ||
            (senderNumber && pId.split('@')[0].split(':')[0].replace(/[^0-9]/g, '') === senderNumber)
          );
        });

        isAdmin = isOwner || Boolean(senderParticipant && checkIsAdmin(senderParticipant));
      }
    } catch (_) {
      isAdmin = isOwner;
    }
  };

  if (isGroup && groupConfig) {
    // 1. Antilink Protection (hanya jika diaktifkan)
    if (groupConfig.antilink) {
      const linkRegex = /(chat\.whatsapp\.com\/[0-9A-Za-z]{20,24})/i;
      if (linkRegex.test(body)) {
        await loadGroupInfo();
        if (!isAdmin && !isOwner) {
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

  // 4. Sesi interaktif registrasi user (.daftar)
  if (registrationSessions.has(sender) && !config.prefixes.some((p) => body.startsWith(p)) && body.trim().length > 0) {
    registrationSessions.delete(sender);
    const regName = body.trim();
    userDb.registerUser(sender, regName);
    return reply(
      `Registrasi berhasil.\n\n` +
      `Nama: ${regName}\n` +
      `Status: UNLIMITED\n\n` +
      `Sekarang kamu dapat menggunakan fitur bot tanpa batas.`
    );
  }

  // Cek Prefix
  const matchedPrefix = config.prefixes.find((p) => body.startsWith(p));
  if (!matchedPrefix) {
    // Jika pesan dari akun bot sendiri (fromMe) dan bukan command berprefix, abaikan agar tidak memicu download otomatis/loop
    if (msg.key?.fromMe) {
      return;
    }

    // Deteksi URL media otomatis (berjalan di private chat dan di grup)
    const urlMatch = body.match(/https?:\/\/[^\s]+/i);
    if (urlMatch) {
      const detectedUrl = urlMatch[0];
      const isMediaUrl = /(tiktok\.com|douyin\.com|instagram\.com|facebook\.com|fb\.watch|fb\.com|threads\.net|twitter\.com|x\.com|youtube\.com|youtu\.be|pinterest\.com|pin\.it|spotify\.com|soundcloud\.com|mediafire\.com|drive\.google\.com|capcut\.com|snackvideo\.com|sck\.io|likee\.video|rednote|xiaohongshu\.com)/i.test(detectedUrl);

      // Di grup, hanya proses jika berupa link media agar tidak mengganggu percakapan / link artikel umum
      if (!isGroup || isMediaUrl) {
        // Status Pemrosesan: Reaksi ⏳ + Indikator Mengetik (composing)
        await startProcessing(sock, msg);
        let downloadSuccess = false;
        let downloadError = null;
        const requestId = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

        try {
          // Periksa Limit Pengguna
          const limitCheck = checkUserLimit(sender, isOwner, isGroup);
          if (!limitCheck.allowed) {
            commandHasFailed = true;
            lastCommandError = limitCheck.message;
            await reply(limitCheck.message);
            return;
          }

          // Jika link adalah TikTok, periksa apakah berupa slide foto atau video
          if (/tiktok\.com/i.test(detectedUrl)) {
            try {
              const data = await scraper.getTikTok(detectedUrl);
              if (data && (data.isSlide || (Array.isArray(data.images) && data.images.length > 0))) {
                const totalPhotos = data.images.length;
                for (let i = 0; i < totalPhotos; i++) {
                  const imgUrl = data.images[i];
                  const isFirst = i === 0;
                  const caption = isFirst
                    ? `✨ *TikTok Slide Foto (${totalPhotos} Foto)*\n\n👤 Author: ${data.author}\n📝 Caption: ${data.title}\n\n📷 Foto [1/${totalPhotos}]`
                    : `📷 Foto [${i + 1}/${totalPhotos}]`;
                  try {
                    const imgRes = await axios.get(imgUrl, {
                      responseType: 'arraybuffer',
                      timeout: 15000,
                      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
                    });
                    await sock.sendMessage(chatId, { image: Buffer.from(imgRes.data), caption }, { quoted: isFirst ? msg : undefined });
                  } catch (_) {
                    await sock.sendMessage(chatId, { image: { url: imgUrl }, caption }, { quoted: isFirst ? msg : undefined });
                  }
                  if (i < totalPhotos - 1) await new Promise((r) => setTimeout(r, 800));
                }
                if (data.audioUrl) {
                  try {
                    await sock.sendMessage(chatId, { audio: { url: data.audioUrl }, mimetype: 'audio/mp4' }, { quoted: msg });
                  } catch (_) {}
                }
                downloadSuccess = true;
                return;
              } else if (data && data.videoUrl) {
                await sock.sendMessage(chatId, {
                  video: { url: data.videoUrl },
                  caption: `✨ *TikTok No Watermark*\n\n👤 Author: ${data.author}\n📝 Caption: ${data.title}`
                }, { quoted: msg });
                downloadSuccess = true;
                return;
              }
            } catch (_) {
              // Lanjut ke fallback yt-dlp jika getTikTok gagal
            }
          }

          // Jika link adalah Instagram (Reel, Post, Carousel Foto & Video, Story)
          if (/instagram\.com/i.test(detectedUrl)) {
            try {
              const isStory = /instagram\.com\/stories\//i.test(detectedUrl);
              const data = isStory
                ? await scraper.getInstagramStory(detectedUrl)
                : await scraper.getInstagram(detectedUrl);

              if (data && Array.isArray(data.media) && data.media.length > 0) {
                const totalMedia = data.media.length;
                for (let i = 0; i < totalMedia; i++) {
                  const item = data.media[i];
                  const isFirst = i === 0;
                  const caption = totalMedia > 1
                    ? (isFirst ? `✨ *Instagram Carousel (${totalMedia} Media)*\n\n${item.type === 'video' ? '🎥' : '📷'} Media [${i + 1}/${totalMedia}]` : `${item.type === 'video' ? '🎥' : '📷'} Media [${i + 1}/${totalMedia}]`)
                    : (isStory ? `✨ *Instagram Story*` : `✨ *Instagram Downloader*`);

                  try {
                    const mediaRes = await axios.get(item.url, {
                      responseType: 'arraybuffer',
                      timeout: 30000,
                      headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Referer': 'https://www.instagram.com/'
                      }
                    });
                    const buffer = Buffer.from(mediaRes.data);
                    const contentType = String(mediaRes.headers['content-type'] || '').toLowerCase();
                    const isVideo = contentType.includes('video') || item.type === 'video' || (buffer.length >= 8 && buffer.slice(4, 8).toString('ascii') === 'ftyp') || /\.mp4/i.test(item.url);

                    if (isVideo) {
                      await sock.sendMessage(chatId, {
                        video: buffer,
                        caption,
                        mimetype: 'video/mp4'
                      }, { quoted: isFirst ? msg : undefined });
                    } else {
                      await sock.sendMessage(chatId, {
                        image: buffer,
                        caption
                      }, { quoted: isFirst ? msg : undefined });
                    }
                  } catch (_) {
                    try {
                      if (item.type === 'video') {
                        await sock.sendMessage(chatId, { video: { url: item.url }, caption }, { quoted: isFirst ? msg : undefined });
                      } else {
                        await sock.sendMessage(chatId, { image: { url: item.url }, caption }, { quoted: isFirst ? msg : undefined });
                      }
                    } catch (e2) {}
                  }

                  if (i < totalMedia - 1) await new Promise((r) => setTimeout(r, 800));
                }
                downloadSuccess = true;
                return;
              }
            } catch (_) {
              // Lanjut ke fallback yt-dlp jika getInstagram gagal
            }
          }

          if (!downloadSuccess) {
            const result = await downloadVideo(detectedUrl, requestId);
            const videoBuffer = fs.readFileSync(result.filePath);
            await sock.sendMessage(chatId, {
              video: videoBuffer,
              caption: `🎥 *${result.title}*\n📦 Ukuran: ${formatBytes(result.fileSize)}`,
              mimetype: 'video/mp4'
            }, { quoted: msg });
            deleteFileSafe(result.filePath);
            downloadSuccess = true;
          }
        } catch (e) {
          downloadSuccess = false;
          downloadError = e.message || 'Gagal memproses media';
          commandHasFailed = true;
          lastCommandError = downloadError;
          if (!isGroup) {
            try {
              await reply(`❌ Gagal mengunduh media dari link: ${downloadError}`);
            } catch (_) {}
          }
        } finally {
          if (downloadSuccess) {
            consumeUserLimit(sender, isOwner, isGroup);
          }
          await stopProcessing(sock, msg, downloadSuccess);

          // Log auto-download ke SQLite
          try {
            const execTimeSec = ((Date.now() - cmdStartTime) / 1000).toFixed(2);
            userDb.logCommand({
              timestamp: Date.now(),
              userId: sender,
              number: senderNumber,
              username: pushName || '',
              command: 'autodownload',
              arguments: detectedUrl,
              chatType: isGroup ? 'group' : 'private',
              chatId: chatId,
              groupName: isGroup ? groupName : '',
              status: downloadSuccess ? 'SUCCESS' : 'FAILED',
              executionTime: parseFloat(execTimeSec),
              error: downloadSuccess ? null : downloadError
            });
          } catch (_) {}
        }
      }
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
    'ttfoto': 'tiktok',
    'tiktokfoto': 'tiktok',
    'ttslide': 'tiktok',
    'tiktokslide': 'tiktok',
    'ttstalk': 'tiktokstalk',
    'stalktt': 'tiktokstalk',
    'ttm': 'tiktokmusic',
    'ttmusik': 'tiktokmusic',
    'ttmusic': 'tiktokmusic',
    'tiktokmusik': 'tiktokmusic',
    'ttmp3': 'tiktokmusic',
    'tiktokmp3': 'tiktokmusic',
    'ttaudio': 'tiktokmusic',
    'tiktokaudio': 'tiktokmusic',
    'ytm': 'ytm',
    'ytmp3': 'ytm',
    'playmp3': 'ytm',
    'instagram': 'ig',
    'igdl': 'ig',
    'igpost': 'ig',
    'reel': 'ig',
    'reels': 'ig',
    'igreel': 'ig',
    'igreels': 'ig',
    'igstory': 'igstory',
    'story': 'igstory',
    'storyig': 'igstory',
    'igs': 'igstory',
    'instastory': 'igstory',
    'tw': 'twitter',
    'x': 'twitter',
    'git': 'gitclone',
    // Search
    'g': 'google',
    // Game
    'ttt': 'tictactoe',
    'coin': 'coinflip',
    'dice': 'dadu',
    // Sticker & Media
    's': 'sticker',
    'stk': 'sticker',
    'stiker': 'sticker',
    'wm': 'take',
    'buka': 'toimg',
    'tovideo': 'tovid',
    'bratvideo': 'bratvid',
    'bratgif': 'bratvid',
    'bratv': 'bratvid',
    'bratanim': 'bratvid',
    'bratpc': 'bratpc',
    'pcbrat': 'bratpc',
    'anyabrat': 'anyabrat',
    'anyabr': 'anyabrat',
    'bratcolor': 'bratcolor',
    'brathd': 'brathd',
    'bratvid2': 'bratvid2',
    'brat2': 'brat2',
    'brat3': 'brat3',
    'animebrat': 'animebrat',
    'animebrat2': 'animebrat2',
    'ttp': 'ttp',
    'attp': 'attp',
    'qc': 'qc',
    'qc2': 'qc2',
    'smeme': 'smeme',
    'emojigif': 'emojigif',
    'emojimix': 'emix',
    'gifsticker': 'gifsticker',
    'stly': 'stly',
    'stickerlysearch': 'stly',
    'telestick': 'telestick',
    'tenor': 'tenor',
    'stickersearch': 'stickersearch',
    'ryo': 'ryo',
    // TTS
    'tts': 'tts',
    'tiktoktts': 'tts',
    'say': 'tts',
    // User & Limit
    'daftar': 'daftar',
    'register': 'daftar',
    'me': 'me',
    'ceklimit': 'limit',
    'limitgc': 'limit',
    'limitgrup': 'limit',
    'premium': 'premium',
    'sewa': 'premium',
    'sewabot': 'premium',
    'prem': 'premium',
    // Admin DB & User Management
    'users': 'users',
    'userinfo': 'userinfo',
    'resetlimit': 'resetlimit',
    'setunlimited': 'setunlimited',
    'setlimit': 'setlimit',
    'addadmin': 'addadmin',
    'tambahadmin': 'addadmin',
    'deladmin': 'deladmin',
    'hapusadmin': 'deladmin',
    'listadmin': 'listadmin',
    'listuser': 'listuser',
    'listusers': 'listuser',
    'daftaruser': 'daftaruser',
    'reguser': 'daftaruser',
    'deluser': 'deluser',
    'hapususer': 'deluser',
    // Tools
    'qr': 'qrcode',
    'short': 'shorturl',
    'tr': 'translate',
    'ss': 'ssweb',
    'cuaca': 'weather',
    'kan': 'kan',
    'rvo': 'kan',
    'viewonce': 'kan',
    // Group
    'infogc': 'groupinfo',
    'linkgc': 'linkgroup',
    'tagang': 'tagall',
    'mentionall': 'tagall',
    // Owner
    'bc': 'broadcast',
    'own': 'owner',
    // AI
    'sum': 'summarize',
    'ringkas': 'summarize',
    // Bot & Submenu
    'info': 'infobot',
    'start': 'menu',
    'donasi': 'donate'
  };

  // Toleransi perintah menu bertingkat yang kurang akurat / typo (misal: .ins, .indown, .ingam, .insear, .in tools, .in download, dll)
  const resolvedTiered = resolveTieredMenu(command, q);
  if (resolvedTiered) {
    command = resolvedTiered;
  }

  if (aliases[command]) {
    command = aliases[command];
  }

  // Quoted message helper
  const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage || null;
  const quotedType = quoted ? Object.keys(quoted)[0] : null;

  if (!command) return;

  const isValidCommand = VALID_COMMANDS.has(command);
  if (!isValidCommand) return;

  db.incrementHit();

  // List seluruh perintah yang terkena sistem limit pengguna harian (hitung hit)
  const LIMITED_COMMANDS = new Set([
    // Download
    'play', 'play2', 'ytm', 'ytmp3', 'yts', 'tiktok', 'tiktokfoto', 'tiktokstalk',
    'tiktokmusic', 'ttmusik', 'ttm',
    'ig', 'igstory', 'twitter', 'gitclone',
    // Search
    'google',
    // Game & Fun
    'tictactoe', 'delttt', 'math', 'ppt', 'suit', 'slot', 'casino',
    'yourmom', 'teri', 'tebakgambar', 'tebakkata', 'coinflip', 'dadu',
    // Sticker & Media
    'sticker', 'take', 'smaker', 'getsticker', 'emix', 'toimg', 'tovid', 'attp', 'ttp',
    'brat', 'bratpc', 'bratcolor', 'brathd', 'bratvid', 'bratvid2', 'brat2', 'brat3', 'anyabrat',
    'animebrat', 'animebrat2', 'qc', 'qc2', 'smeme', 'emojigif', 'gifsticker', 'stly',
    'stickerlysearch', 'telestick', 'tenor', 'stickersearch', 'ryo',
    // Tools
    'pdf', 'qrcode', 'shorturl', 'translate', 'ssweb', 'ocr', 'weather', 'calc',
    // AI
    'ai', 'ask', 'imagine', 'summarize',
    // TTS
    'tts'
  ]);

  let commandExecutedSuccessfully = false;
  const isLimitedCmd = LIMITED_COMMANDS.has(command);

  // Status Pemrosesan Global: Reaksi ⏳ + Indikator Mengetik (composing)
  await startProcessing(sock, msg);
  try {
    if (isLimitedCmd) {
      const limitCheck = checkUserLimit(sender, isOwner, isGroup);
      if (!limitCheck.allowed) {
        commandHasFailed = true;
        return reply(limitCheck.message);
      }
    }
  /* ====================================================================
   * 1. 🤖 BOT MENU & TIERED SUBMENUS
   * ==================================================================== */
  if (command === 'menu' || command === 'help' || command === 'start') {
    commandExecutedSuccessfully = true;
    const dbUser = userDb.getUser(sender);
    const isRegistered = Boolean(dbUser && dbUser.registered === 1);
    const greeting = isGroup ? `@${senderNumber}` : ((dbUser && dbUser.name) ? dbUser.name : (pushName || 'Kak'));
    const banner = getMainCategoryMenu(greeting, isRegistered);
    return await reply(banner, { mentions: [sender] });
  }

  if (command === 'inmenu') {
    commandExecutedSuccessfully = true;
    return await reply(getGeneralMenu());
  }

  if (command === 'indownload') {
    commandExecutedSuccessfully = true;
    return await reply(getDownloadMenu());
  }

  if (command === 'insearch') {
    commandExecutedSuccessfully = true;
    return await reply(getSearchMenu());
  }

  if (command === 'ingame') {
    commandExecutedSuccessfully = true;
    return await reply(getGameMenu());
  }

  if (command === 'insticker') {
    commandExecutedSuccessfully = true;
    return await reply(getStickerMenu());
  }

  if (command === 'intts') {
    commandExecutedSuccessfully = true;
    return await reply(getTtsMenu());
  }

  if (command === 'inuser') {
    commandExecutedSuccessfully = true;
    return await reply(getUserMenu());
  }

  if (command === 'intools') {
    commandExecutedSuccessfully = true;
    return await reply(getToolsMenu());
  }

  if (command === 'ingroup') {
    commandExecutedSuccessfully = true;
    return await reply(getGroupMenu());
  }

  if (command === 'inadmin') {
    commandExecutedSuccessfully = true;
    return await reply(getAdminMenu());
  }

  if (command === 'inai') {
    commandExecutedSuccessfully = true;
    return await reply(getAiMenu());
  }

  if (command === 'ininfo') {
    commandExecutedSuccessfully = true;
    return await reply(getInfoMenu());
  }

  if (command === 'inlog') {
    commandExecutedSuccessfully = true;
    return await reply(getLogMenu());
  }

  if (command === 'ping') {
    const latency = Date.now() - (msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now());
    const displayLatency = Math.max(1, Math.abs(latency));
    commandExecutedSuccessfully = true;
    return await sock.sendMessage(chatId, {
      text: `🏓 *Pong!*\n\n⚡ *Kecepatan Respon:* ${displayLatency} ms\n⏱️ *Uptime:* ${formatUptime(Math.floor((Date.now() - startTime) / 1000))}\n🟢 *Server:* Aktif & Normal`
    }, { quoted: msg });
  }

  if (command === 'alive') {
    commandExecutedSuccessfully = true;
    return reply(`🟢 *${config.botName}* Berjalan Aktif!\nSemua sistem downloader, game, tools, modul stiker, dan AI siap digunakan 24/7.`);
  }

  if (command === 'uptime' || command === 'runtime') {
    const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
    commandExecutedSuccessfully = true;
    return reply(`⏱️ *Uptime Bot:* ${formatUptime(uptimeSec)}\n🗓️ *Waktu Mulai:* ${new Date(startTime).toLocaleString('id-ID')}`);
  }

  if (command === 'bot' || command === 'infobot') {
    const mem = process.memoryUsage();
    const stats = userDb.getUsersStats();
    commandExecutedSuccessfully = true;
    return reply(`🤖 *INFORMASI BOT*\n\n` +
      `• *Nama:* ${config.botName}\n` +
      `• *Versi:* ${config.botVersion}\n` +
      `• *Total Hit:* ${db.getHits().toLocaleString('id-ID')} kali\n` +
      `• *Total User:* ${stats.total.toLocaleString('id-ID')} user\n` +
      `• *Node.js:* ${process.version}\n` +
      `• *Platform:* ${process.platform} (${process.arch})\n` +
      `• *RAM Digunakan:* ${formatBytes(mem.rss)}\n` +
      `• *Prefix:* ${config.prefix}\n` +
      `• *Owner:* ${config.owner.name}`);
  }

  if (command === 'me') {
    const u = userDb.getUser(sender, pushName);
    const limitCheck = checkUserLimit(sender, isOwner, isGroup);
    const totalCmds = u?.total_commands || 0;
    const succCmds = u?.success_commands || 0;
    const failCmds = u?.failed_commands || 0;
    const firstSeen = u?.created_at ? new Date(u.created_at).toLocaleDateString('id-ID') : '-';
    const lastSeen = u?.updated_at ? new Date(u.updated_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '-';

    let role = 'User';
    if (isOwner) role = 'Owner';
    else if (userDb.isBotAdmin(sender)) role = 'Admin Bot';
    else if (u?.premium === 1) role = 'Premium VIP';

    const isReg = (u?.registered === 1 || isOwner) ? 'Registered' : 'Not Registered';
    const isPrem = (u?.premium === 1 || isOwner) ? 'Yes' : 'No';
    const isUnlim = (limitCheck.isUnlimited) ? 'Yes' : 'No';

    const hitsToday = u?.hits_today || 0;
    const maxLimit = limitCheck.maxLimit;
    const limitDisplay = limitCheck.isUnlimited ? 'Unlimited ♾️' : `${hitsToday}/${maxLimit} hit (Sisa: ${limitCheck.remaining})`;

    const timeLeft = userDb.getTimeUntilMidnightWib();
    const resetDisplay = limitCheck.isUnlimited ? '-' : `${timeLeft.hours}j ${timeLeft.minutes}m (00:00 WIB)`;

    let premPkg = '-';
    let premExp = '-';
    if (u?.premium === 1) {
      premPkg = u.premium_package || 'Premium';
      if (u.premium_expires_at) {
        const expDate = new Date(u.premium_expires_at);
        premExp = expDate.toLocaleDateString('id-ID') + ' ' + expDate.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
      } else {
        premExp = 'Permanen';
      }
    }

    // Pastikan nomor selalu terisi jika tersedia dari senderNumber, data user di database, atau LID mapping
    const resolvedPhone = senderNumber || u?.phone || (sender.includes('@lid') ? userDb.getPhoneByLid(sender) : null);
    if (!senderNumber && resolvedPhone && sender.includes('@lid')) {
      userDb.saveLidMapping(sender, resolvedPhone);
    }
    const phoneDisplay = formatPhoneDisplay(resolvedPhone);

    const meText = `╭───〔 👤 MY PROFILE 〕
│
├ Nama       : ${u?.name || pushName || 'User'}
├ Nomor      : ${phoneDisplay}
├ Status     : ${isReg}
├ Role       : ${role}
├ Premium    : ${isPrem}${u?.premium === 1 ? ` (${premPkg})` : ''}
├ Unlimited  : ${isUnlim}
├ Limit Hari : ${limitDisplay}
├ Reset Jam  : ${resetDisplay}
${u?.premium === 1 ? `├ Kedaluwarsa: ${premExp}\n` : ''}├ Commands   : ${totalCmds.toLocaleString('id-ID')}
├ Success    : ${succCmds.toLocaleString('id-ID')}
├ Failed     : ${failCmds.toLocaleString('id-ID')}
├ First Seen : ${firstSeen}
├ Last Seen  : ${lastSeen}
╰────────────────`;

    commandExecutedSuccessfully = true;
    return reply(meText);
  }

  if (command === 'limit' || command === 'ceklimit') {
    commandExecutedSuccessfully = true;
    return reply(formatUserStatus(sender, isOwner, isGroup));
  }

  if (command === 'premium' || command === 'sewa' || command === 'sewabot') {
    commandExecutedSuccessfully = true;
    const infoPrem = `👑 *PAKET PREMIUM SIKANBOT* 👑\n\n` +
      `Tingkatkan akun Anda ke *Premium VIP* untuk menikmati akses *UNLIMITED HIT* tanpa batas limit harian ke seluruh fitur bot!\n\n` +
      `💎 *PILIHAN PAKET:*\n` +
      `1. *Paket 7 Hari*  : Rp5.000 (Hemat)\n` +
      `2. *Paket 30 Hari* : Rp10.000 (Terpopuler 🔥)\n\n` +
      `⚡ *KEUNTUNGAN PREMIUM:*\n` +
      `• Unlimited Hit harian tanpa batas (Bebas pakai)\n` +
      `• Akses bebas limit di chat pribadi maupun grup\n` +
      `• Prioritas antrean eksekusi lebih cepat\n` +
      `• Badge khusus Premium di profil (*.me*)\n` +
      `• Dukungan penuh langsung dari Owner\n\n` +
      `📞 *CARA BERLANGGANAN:*\n` +
      `Hubungi Owner bot sekarang juga:\n` +
      `• Ketik: *${config.prefix}owner*\n` +
      `• WhatsApp: https://wa.me/${config.owner.number.replace(/[^0-9]/g, '')}\n` +
      `• Nama Owner: *${config.owner.name}*`;
    return reply(infoPrem);
  }

  if (command === 'daftar' || command === 'register') {
    // Nomor HP pendaftaran diambil dari pesan masuk ataupun dari reply chat
    const quotedPhone = getQuotedUserNumber(msg, sock, groupMetadata);
    const incomingPhone = userNumber;

    let targetPhone = null;
    let isFromReply = false;

    // Jika pesan merupakan balasan (reply chat)
    if (quotedPhone) {
      if (botNumber && quotedPhone === botNumber) {
        // User me-reply chat bot (misal petunjuk pendaftaran), daftarkan nomor pengirim pesan masuk
        targetPhone = incomingPhone;
      } else {
        // User/admin me-reply chat user lain atau pesan dirinya sendiri
        targetPhone = quotedPhone;
        isFromReply = true;
      }
    } else {
      // Tidak ada reply chat, ambil dari pesan masuk (sender)
      targetPhone = incomingPhone;
    }

    // Fallback jika salah satu null
    if (!targetPhone) {
      targetPhone = incomingPhone || quotedPhone;
    }

    if (!q || !q.includes('-')) {
      return reply(
        `❌ Format pendaftaran salah.\n\n` +
        `Gunakan:\n` +
        `${config.prefix}daftar Nama User - Kota - Umur\n\n` +
        `Atau jika nomor Anda tersembunyi (LID/Privasi WA):\n` +
        `${config.prefix}daftar [Nomor WA] - Nama User - Kota - Umur\n\n` +
        `Contoh:\n` +
        `${config.prefix}daftar Rahmat Haikal - Lhokseumawe - 20\n` +
        `${config.prefix}daftar 082267034994 - Rahmat Haikal - Lhokseumawe - 20\n\n` +
        `_Tips: Anda juga bisa me-reply chat user lain untuk mendaftarkannya._`
      );
    }

    let parts = q.split('-').map((s) => s.trim());

    // Cek apakah ada nomor telepon yang dimasukkan manual di salah satu bagian
    let manualPhone = null;
    const phoneIdx = parts.findIndex((p) => {
      const norm = normalizePhoneNumber(p);
      return norm && isValidPhoneNumber(norm);
    });

    if (phoneIdx !== -1) {
      manualPhone = normalizePhoneNumber(parts[phoneIdx]);
      parts.splice(phoneIdx, 1);
    }

    // Jika ada nomor manual atau jika targetPhone belum terdeteksi otomatis, gunakan manualPhone
    if (manualPhone) {
      targetPhone = manualPhone;
      // Jika pengirim berupa LID, tautkan LID dengan nomor ini secara permanen
      const senderLid = String(msg.key?.participant || msg.participant || chatId);
      if (senderLid.includes('@lid')) {
        userDb.saveLidMapping(senderLid, targetPhone);
      }
    }

    if (!targetPhone || !isValidUserNumber(targetPhone)) {
      return reply(
        `❌ Gagal memproses pendaftaran: Nomor WhatsApp asli Anda tidak dapat dideteksi dari pesan masuk maupun reply chat. Pastikan privasi nomor Anda terlihat di WhatsApp atau balas pesan chat user yang valid.\n\n` +
        `💡 *Solusi:* Silakan daftar dengan menyertakan nomor HP Anda secara langsung:\n` +
        `Contoh:\n` +
        `${config.prefix}daftar 082267034994 - ${q}`
      );
    }

    if (parts.length < 3) {
      return reply(
        `❌ Format pendaftaran salah.\n\n` +
        `Gunakan:\n` +
        `${config.prefix}daftar Nama User - Kota - Umur\n\n` +
        `Contoh:\n` +
        `${config.prefix}daftar Rahmat Haikal - Lhokseumawe - 20`
      );
    }

    const regName = parts[0];
    const regKota = parts[1];
    const regUmur = parseInt(parts[2], 10);

    if (!regName || !regKota || isNaN(regUmur) || regUmur <= 0) {
      return reply(
        `❌ Format pendaftaran salah.\n\n` +
        `Gunakan:\n` +
        `${config.prefix}daftar Nama User - Kota - Umur\n\n` +
        `Contoh:\n` +
        `${config.prefix}daftar Rahmat Haikal - Lhokseumawe - 20`
      );
    }

    const targetJid = `${targetPhone}@s.whatsapp.net`;
    const existingUser = userDb.getUser(targetJid);
    if (existingUser && existingUser.registered === 1) {
      if (isFromReply && targetPhone !== incomingPhone) {
        return reply(`ℹ️ User dengan nomor ${formatPhoneDisplay(targetPhone)} sudah terdaftar sebagai User #${existingUser.id} (${existingUser.name}).`);
      }
      return reply(`ℹ️ Kamu sudah terdaftar sebagai User #${existingUser.id}.`);
    }

    // Tautkan LID pengirim (jika ada) ke targetPhone
    const senderLid = String(msg.key?.participant || msg.participant || chatId);
    if (senderLid.includes('@lid')) {
      userDb.saveLidMapping(senderLid, targetPhone);
    }

    const newUser = userDb.registerUserWithDetails(targetJid, {
      name: regName,
      kota: regKota,
      umur: regUmur
    });

    commandExecutedSuccessfully = true;
    return reply(
      `✅ *PENDAFTARAN BERHASIL*\n\n` +
      `🆔 ID    : ${newUser.id}\n` +
      `👤 Nama  : ${newUser.name}\n` +
      `📱 Nomor : ${formatPhoneDisplay(newUser.phone)}\n` +
      `📍 Kota  : ${newUser.kota}\n` +
      `🎂 Umur  : ${newUser.umur}` +
      (isFromReply && targetPhone !== incomingPhone ? `\n\n📢 _Nomor otomatis diambil dari reply chat._` : '')
    );
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
│ 📱 Owner WA : +${config.owner.number.replace(/[^0-9]/g, '')}
│ 📞 Kontak WA: ${config.owner.phone}
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
├ Owner WA  : +${config.owner.number.replace(/[^0-9]/g, '')}
├ Kontak WA : ${config.owner.phone}
├ Instagram : [${config.owner.instagram}]
├ Email     : [${config.owner.email}]
│
├ Bot       : ${config.botName}
├ Prefix    : ${config.prefix}
│
╰──────────────
`;

    return reply(fullCard);
  }

  if (command === 'script') {
    return reply(`💻 *SCRIPT BOT*\n\nRepository: https://github.com/${config.owner.github}/sikanbot\nDeveloper: ${config.owner.name}\nBase: @whiskeysockets/baileys & Node.js`);
  }

  if (command === 'donate') {
    return reply(`☕ *DONASI & DUKUNGAN*\n\n` +
      `Bantu server bot tetap menyala dengan donasi seikhlasnya:\n` +
      `A.n *${config.donate.name}*\n` +
      `* DANA: *${config.donate.dana}*\n` +
      `* GoPay: *${config.donate.gopay}*\n\n\n` +
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
  if (command === 'play' || command === 'ytm' || command === 'ytmp3') {
    let queryText = q.trim();
    if (!queryText && quotedMessage) {
      const quotedText = (
        quotedMessage?.conversation ||
        quotedMessage?.extendedTextMessage?.text ||
        quotedMessage?.imageMessage?.caption ||
        quotedMessage?.videoMessage?.caption ||
        ''
      ).trim();
      if (quotedText) queryText = quotedText;
    }

    if (!queryText) {
      return reply(
        `🎵 *YouTube Music Downloader*\n\n` +
        `Masukkan judul lagu atau link YouTube!\n\n` +
        `*Contoh Judul:* ${config.prefix}ytm Denny Caknan Cundamani\n` +
        `*Contoh Link:* ${config.prefix}play https://www.youtube.com/watch?v=...`
      );
    }

    const tempAudio = path.join(config.tempDir, `audio_${Date.now()}.mp3`);
    try {
      const dlRes = await scraper.downloadYouTubeAudio(queryText, tempAudio);
      if (dlRes.success && fs.existsSync(tempAudio)) {
        const audioBuffer = fs.readFileSync(tempAudio);
        const cleanTitle = (dlRes.title || 'youtube_music').slice(0, 40).replace(/[\\/:*?"<>|]/g, '').trim() || 'youtube_music';
        await sock.sendMessage(chatId, {
          audio: audioBuffer,
          mimetype: 'audio/mpeg',
          fileName: `${cleanTitle}.mp3`,
          ptt: false
        }, { quoted: msg });
        deleteFileSafe(tempAudio);
        commandExecutedSuccessfully = true;
      } else {
        reply('❌ Gagal mengunduh audio YouTube.');
      }
    } catch (e) {
      deleteFileSafe(tempAudio);
      reply(`❌ Error: ${e.message}`);
    }
    return;
  }

  if (command === 'play2') {
    let queryText = q.trim();
    if (!queryText && quotedMessage) {
      const quotedText = (
        quotedMessage?.conversation ||
        quotedMessage?.extendedTextMessage?.text ||
        quotedMessage?.imageMessage?.caption ||
        quotedMessage?.videoMessage?.caption ||
        ''
      ).trim();
      if (quotedText) queryText = quotedText;
    }

    if (!queryText) {
      return reply(
        `🎥 *YouTube Video Downloader*\n\n` +
        `Masukkan judul video atau link YouTube!\n\n` +
        `*Contoh:* ${config.prefix}play2 anime edit\n` +
        `*Contoh Link:* ${config.prefix}play2 https://www.youtube.com/watch?v=...`
      );
    }

    const tempVideo = path.join(config.tempDir, `vid_${Date.now()}.mp4`);
    try {
      const dlRes = await scraper.downloadYouTubeVideo(queryText, tempVideo);
      if (dlRes.success && fs.existsSync(tempVideo)) {
        const vidBuffer = fs.readFileSync(tempVideo);
        await sock.sendMessage(chatId, {
          video: vidBuffer,
          caption: `🎥 *YouTube Video:* ${dlRes.title}`,
          mimetype: 'video/mp4'
        }, { quoted: msg });
        deleteFileSafe(tempVideo);
        commandExecutedSuccessfully = true;
      } else {
        reply('❌ Gagal mengunduh video YouTube.');
      }
    } catch (e) {
      deleteFileSafe(tempVideo);
      reply(`❌ Error: ${e.message}`);
    }
    return;
  }

  if (command === 'tiktok' || command === 'tiktokfoto') {
    if (!q) {
      return reply(
        `Masukkan link TikTok (video atau slide foto)!\n` +
        `Contoh:\n` +
        `*${config.prefix}tiktok https://vt.tiktok.com/...*\n` +
        `*${config.prefix}tt https://www.tiktok.com/@user/photo/...*`
      );
    }

    try {
      const data = await scraper.getTikTok(q);

      // KASUS 1: POSTINGAN ADALAH SLIDE FOTO / GAMBAR
      if (data.isSlide || (Array.isArray(data.images) && data.images.length > 0)) {
        const totalPhotos = data.images.length;

        for (let i = 0; i < totalPhotos; i++) {
          const imgUrl = data.images[i];
          const isFirst = i === 0;
          const caption = isFirst
            ? `✨ *TikTok Slide Foto (${totalPhotos} Foto)*\n\n` +
              `👤 *Author:* ${data.author} ${data.authorUsername ? '(@' + data.authorUsername + ')' : ''}\n` +
              `📝 *Caption:* ${data.title}\n\n` +
              `📷 Foto [1/${totalPhotos}]`
            : `📷 Foto [${i + 1}/${totalPhotos}]`;

          try {
            const imgRes = await axios.get(imgUrl, {
              responseType: 'arraybuffer',
              timeout: 15000,
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
              }
            });
            await sock.sendMessage(chatId, {
              image: Buffer.from(imgRes.data),
              caption
            }, { quoted: isFirst ? msg : undefined });
          } catch (_) {
            await sock.sendMessage(chatId, {
              image: { url: imgUrl },
              caption
            }, { quoted: isFirst ? msg : undefined });
          }

          if (i < totalPhotos - 1) {
            await new Promise((r) => setTimeout(r, 800));
          }
        }

        // Kirim audio latar jika ada
        if (data.audioUrl) {
          try {
            await new Promise((r) => setTimeout(r, 800));
            await sock.sendMessage(chatId, {
              audio: { url: data.audioUrl },
              mimetype: 'audio/mp4',
              fileName: `${data.title ? data.title.slice(0, 30) : 'tiktok_audio'}.mp3`
            }, { quoted: msg });
          } catch (_) {}
        }
        return;
      }

      // KASUS 2: POSTINGAN ADALAH VIDEO
      if (data.videoUrl) {
        await sock.sendMessage(chatId, {
          video: { url: data.videoUrl },
          caption: `✨ *TikTok No Watermark*\n\n👤 Author: ${data.author}\n📝 Caption: ${data.title}`
        }, { quoted: msg });
        return;
      }

      throw new Error('Tidak ditemukan video ataupun foto dari link TikTok ini.');
    } catch (e) {
      // Fallback ke yt-dlp jika scraper API gagal (khusus video)
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
        reply(`❌ Gagal memproses TikTok: ${e.message || err2.message}`);
      }
    }
    return;
  }

  if (command === 'tiktokmusic' || command === 'tiktokmusik' || command === 'ttmusik') {
    let targetUrl = q.trim();
    if (!targetUrl && quotedMessage) {
      const quotedText = (
        quotedMessage?.conversation ||
        quotedMessage?.extendedTextMessage?.text ||
        quotedMessage?.imageMessage?.caption ||
        quotedMessage?.videoMessage?.caption ||
        ''
      ).trim();
      const match = quotedText.match(/https?:\/\/[^\s]+/i);
      if (match) targetUrl = match[0];
    }

    if (!targetUrl) {
      return reply(
        `🎵 *TikTok Music Downloader*\n\n` +
        `Kirim perintah beserta link TikTok atau balas pesan yang berisi link TikTok!\n\n` +
        `*Format:* ${config.prefix}ttmusik <link tiktok>\n` +
        `*Contoh:* ${config.prefix}ttmusik https://vt.tiktok.com/xxxx/`
      );
    }

    try {
      let audioSent = false;
      // 1. Coba ambil audio langsung dari scraper getTikTok
      try {
        const data = await scraper.getTikTok(targetUrl);
        if (data && data.audioUrl) {
          const cleanTitle = (data.title || 'tiktok_music').slice(0, 40).replace(/[\\/:*?"<>|]/g, '').trim() || 'tiktok_music';
          let audioPayload = { url: data.audioUrl };
          try {
            const audioRes = await axios.get(data.audioUrl, {
              responseType: 'arraybuffer',
              timeout: 20000,
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
            });
            audioPayload = Buffer.from(audioRes.data);
          } catch (_) {}

          await sock.sendMessage(chatId, {
            audio: audioPayload,
            mimetype: 'audio/mp4',
            fileName: `${cleanTitle}.mp3`,
            ptt: false
          }, { quoted: msg });
          audioSent = true;
          commandExecutedSuccessfully = true;
          return;
        }
      } catch (_) {}

      // 2. Fallback: Ekstraksi audio via downloadAudio (yt-dlp)
      if (!audioSent) {
        const reqId = `tt_audio_${Date.now()}`;
        const result = await downloadAudio(targetUrl, reqId);
        const audioBuf = fs.readFileSync(result.filePath);
        const cleanTitle = (result.title || 'tiktok_audio').slice(0, 40).replace(/[\\/:*?"<>|]/g, '').trim() || 'tiktok_audio';
        await sock.sendMessage(chatId, {
          audio: audioBuf,
          mimetype: 'audio/mpeg',
          fileName: `${cleanTitle}.mp3`,
          ptt: false
        }, { quoted: msg });
        deleteFileSafe(result.filePath);
        commandExecutedSuccessfully = true;
        return;
      }
    } catch (e) {
      reply(`❌ Gagal mengunduh musik TikTok: ${e.message}`);
    }
    return;
  }

  if (command === 'tiktokstalk') {
    if (!q) return reply(`Masukkan username TikTok!\nContoh: *${config.prefix}tiktokstalk sandikagalih*`);
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

  if (command === 'ig' || command === 'igstory') {
    if (!q) {
      if (command === 'igstory') {
        return reply(`📸 *Instagram Story Downloader*\n\nMasukkan link Story Instagram atau username akun!\n\n📌 *Contoh Link:*\n*${config.prefix}igstory https://www.instagram.com/stories/...*\n\n📌 *Contoh Username:*\n*${config.prefix}igstory rahmathaikal.05*`);
      }
      return reply(`📸 *Instagram Downloader*\n\nMasukkan URL Instagram (Reel, Post, Carousel Foto & Video, atau Story)!\n\n📌 *Contoh:*\n*${config.prefix}ig https://www.instagram.com/reel/...*\n*${config.prefix}ig https://www.instagram.com/p/...*`);
    }

    const isStoryCmd = command === 'igstory' || /instagram\.com\/stories\//i.test(q);

    try {
      const data = isStoryCmd
        ? await scraper.getInstagramStory(q)
        : await scraper.getInstagram(q);

      if (data && Array.isArray(data.media) && data.media.length > 0) {
        const totalMedia = data.media.length;

        for (let i = 0; i < totalMedia; i++) {
          const item = data.media[i];
          const isFirst = i === 0;
          const caption = totalMedia > 1
            ? (isFirst ? `✨ *Instagram Carousel (${totalMedia} Media)*\n\n${item.type === 'video' ? '🎥' : '📷'} Media [${i + 1}/${totalMedia}]` : `${item.type === 'video' ? '🎥' : '📷'} Media [${i + 1}/${totalMedia}]`)
            : (isStoryCmd ? `✨ *Instagram Story*` : `✨ *Instagram Downloader*`);

          try {
            const mediaRes = await axios.get(item.url, {
              responseType: 'arraybuffer',
              timeout: 30000,
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://www.instagram.com/'
              }
            });
            const buffer = Buffer.from(mediaRes.data);
            const contentType = String(mediaRes.headers['content-type'] || '').toLowerCase();
            const isVideo = contentType.includes('video') || item.type === 'video' || (buffer.length >= 8 && buffer.slice(4, 8).toString('ascii') === 'ftyp') || /\.mp4/i.test(item.url);

            if (isVideo) {
              await sock.sendMessage(chatId, {
                video: buffer,
                caption,
                mimetype: 'video/mp4'
              }, { quoted: isFirst ? msg : undefined });
            } else {
              await sock.sendMessage(chatId, {
                image: buffer,
                caption
              }, { quoted: isFirst ? msg : undefined });
            }
          } catch (fetchErr) {
            try {
              if (item.type === 'video') {
                await sock.sendMessage(chatId, { video: { url: item.url }, caption }, { quoted: isFirst ? msg : undefined });
              } else {
                await sock.sendMessage(chatId, { image: { url: item.url }, caption }, { quoted: isFirst ? msg : undefined });
              }
            } catch (sendErr) {
              log('WARN', `Gagal mengirim media Instagram: ${sendErr.message}`);
            }
          }

          if (i < totalMedia - 1) {
            await new Promise((r) => setTimeout(r, 800));
          }
        }
        return;
      }
      throw new Error('Tidak ada media yang berhasil ditemukan dari link Instagram ini.');
    } catch (igErr) {
      // Fallback ke yt-dlp jika getInstagram gagal pada link reguler
      if (!isStoryCmd && /^https?:\/\//i.test(q)) {
        try {
          const reqId = `ig_${Date.now()}`;
          const res = await downloadVideo(q, reqId);
          const videoBuff = fs.readFileSync(res.filePath);
          await sock.sendMessage(chatId, {
            video: videoBuff,
            caption: `🎥 *${res.title}*\n📦 Ukuran: ${formatBytes(res.fileSize)}`
          }, { quoted: msg });
          deleteFileSafe(res.filePath);
          return;
        } catch (_) {}
      }
      return reply(`❌ Gagal mengunduh Instagram: ${igErr.message}\n\n💡 *Tips:* Pastikan akun Instagram bersifat publik dan link postingan valid. Untuk konten yang memerlukan login, letakkan file *cookies.txt* di folder bot.`);
    }
    return;
  }

  if (command === 'twitter') {
    if (!q) return reply(`Masukkan URL Twitter/X!\nContoh: *${config.prefix}twitter https://twitter.com/...*`);
    const reqId = `twitter_${Date.now()}`;
    try {
      const res = await downloadVideo(q, reqId);
      const videoBuff = fs.readFileSync(res.filePath);
      await sock.sendMessage(chatId, {
        video: videoBuff,
        caption: `🎥 *${res.title}*\n📦 Ukuran: ${formatBytes(res.fileSize)}`
      }, { quoted: msg });
      deleteFileSafe(res.filePath);
      commandExecutedSuccessfully = true;
    } catch (err) {
      reply(`❌ Gagal mengunduh: ${err.message}`);
    }
    return;
  }

  if (command === 'gitclone') {
    if (!q) return reply(`Masukkan link GitHub repository!\nContoh: *${config.prefix}gitclone https://github.com/user/repo*`);
    try {
      const repoData = scraper.getGitClone(q);
      const zipRes = await axios.get(repoData.zipUrl, {
        responseType: 'arraybuffer',
        maxRedirects: 5,
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      const zipBuffer = Buffer.from(zipRes.data);
      if (zipBuffer.length > config.maxFileSizeMB * 1024 * 1024) {
        return reply(`❌ Ukuran file repository (${formatBytes(zipBuffer.length)}) melebihi batas bot (${config.maxFileSizeMB} MB).`);
      }
      await sock.sendMessage(chatId, {
        document: zipBuffer,
        fileName: repoData.filename,
        mimetype: 'application/zip',
        caption: `📦 *GitHub Repository:* ${repoData.user}/${repoData.repo}\n📦 Ukuran: ${formatBytes(zipBuffer.length)}`
      }, { quoted: msg });
      commandExecutedSuccessfully = true;
    } catch (e) {
      reply(`❌ Gagal mengunduh repo: ${e.message}`);
    }
    return;
  }

  /* ====================================================================
   * 3. 🔎 SEARCH
   * ==================================================================== */
  if (command === 'google') {
    if (!q) return reply(`Masukkan query pencarian Google!\nContoh: *${config.prefix}google penemu komputer*`);
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
    if (!q) return reply(`Masukkan judul video YouTube!\nContoh: *${config.prefix}yts Denny Caknan*`);
    try {
      const list = await scraper.searchYouTube(q, 5);
      if (list.length === 0) return reply('Video tidak ditemukan.');
      let out = `🎬 *HASIL PENCARIAN YOUTUBE*\n\n`;
      list.forEach((v, i) => {
        out += `${i + 1}. *${v.title}*\n⏱️ Durasi: ${v.duration} | 👤 Channel: ${v.author}\n🔗 ${v.url}\n\n`;
      });
      out += `💡 *Tips:* Ketik *${config.prefix}ytm <judul/link>* untuk unduh musik, atau *${config.prefix}play2 <judul/link>* untuk unduh video.`;
      commandExecutedSuccessfully = true;
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
    try {
      const bratSticker = await createBratSticker(q, false, config.sticker.packname, config.sticker.author);
      await sock.sendMessage(chatId, { sticker: bratSticker }, { quoted: msg });
    } catch (e) {
      reply(`❌ Gagal membuat stiker brat: ${e.message}`);
    }
    return;
  }

  if (command === 'bratvid') {
    if (!q) return reply(`Masukkan teks untuk stiker brat animasi/bergerak!\nContoh: *${config.prefix}bratvid lagi mikirin kamu*`);
    try {
      const bratSticker = await createBratVideoSticker(q, config.sticker.packname, config.sticker.author);
      commandExecutedSuccessfully = true;
      await sock.sendMessage(chatId, { sticker: bratSticker }, { quoted: msg });
    } catch (e) {
      reply(`❌ Gagal membuat stiker brat animasi: ${e.message}`);
    }
    return;
  }

  if (command === 'bratpc') {
    let textInput = q;
    if (!textInput && quotedMessage) {
      textInput = quotedMessage?.conversation ||
                  quotedMessage?.extendedTextMessage?.text ||
                  quotedMessage?.imageMessage?.caption ||
                  quotedMessage?.videoMessage?.caption || '';
    }
    if (!textInput) {
      return reply(`Masukkan teks stiker Brat PC Windows Media Player!\nContoh: *${config.prefix}bratpc emang BOT nya bisa apa..*`);
    }
    try {
      const stk = await generateBratPc(textInput, config.sticker.packname, config.sticker.author);
      commandExecutedSuccessfully = true;
      await sock.sendMessage(chatId, { sticker: stk }, { quoted: msg });
    } catch (e) {
      reply(`❌ Gagal membuat stiker Brat PC: ${e.message}`);
    }
    return;
  }

  if (command === 'anyabrat') {
    if (!q) return reply(`Masukkan teks stiker Anya Brat!\nContoh: *${config.prefix}anyabrat waku waku*`);
    try {
      const stk = await generateBratCustom({ text: q, isAnya: true });
      commandExecutedSuccessfully = true;
      await sock.sendMessage(chatId, { sticker: stk }, { quoted: msg });
    } catch (e) {
      reply(`❌ Gagal membuat stiker Anya: ${e.message}`);
    }
    return;
  }

  if (command === 'bratcolor') {
    if (!q) return reply(`Format: *${config.prefix}bratcolor <teks>|<background>|<warna font>*\nContoh: *${config.prefix}bratcolor SikanBot|black|yellow*`);
    try {
      const parts = q.split('|').map((s) => s.trim());
      const txt = parts[0] || 'brat';
      const bg = parts[1] || '#ffffff';
      const clr = parts[2] || '#000000';
      const stk = await generateBratCustom({ text: txt, bgColor: bg, textColor: clr });
      commandExecutedSuccessfully = true;
      await sock.sendMessage(chatId, { sticker: stk }, { quoted: msg });
    } catch (e) {
      reply(`❌ Gagal membuat stiker bratcolor: ${e.message}`);
    }
    return;
  }

  if (command === 'brathd') {
    if (!q) return reply(`Masukkan teks untuk stiker Brat HD!\nContoh: *${config.prefix}brathd sikanbot hd*`);
    try {
      const stk = await generateBratCustom({ text: q, isHd: true });
      commandExecutedSuccessfully = true;
      await sock.sendMessage(chatId, { sticker: stk }, { quoted: msg });
    } catch (e) {
      reply(`❌ Gagal membuat stiker HD: ${e.message}`);
    }
    return;
  }

  if (command === 'brat2') {
    if (!q) return reply(`Masukkan teks untuk stiker Brat Lime Classic!\nContoh: *${config.prefix}brat2 Charli XCX*`);
    try {
      const stk = await generateBratCustom({ text: q, bgColor: '#8ACE00', textColor: '#000000' });
      commandExecutedSuccessfully = true;
      await sock.sendMessage(chatId, { sticker: stk }, { quoted: msg });
    } catch (e) {
      reply(`❌ Gagal membuat stiker brat2: ${e.message}`);
    }
    return;
  }

  if (command === 'brat3') {
    if (!q) return reply(`Masukkan teks untuk stiker Brat Inverted!\nContoh: *${config.prefix}brat3 dark brat*`);
    try {
      const stk = await generateBratCustom({ text: q, bgColor: '#000000', textColor: '#ffffff' });
      commandExecutedSuccessfully = true;
      await sock.sendMessage(chatId, { sticker: stk }, { quoted: msg });
    } catch (e) {
      reply(`❌ Gagal membuat stiker brat3: ${e.message}`);
    }
    return;
  }

  if (command === 'bratvid2') {
    if (!q) return reply(`Masukkan teks untuk stiker Brat Video V2!\nContoh: *${config.prefix}bratvid2 sedang berproses*`);
    try {
      const bratSticker = await createBratVideoSticker(q, config.sticker.packname, config.sticker.author);
      commandExecutedSuccessfully = true;
      await sock.sendMessage(chatId, { sticker: bratSticker }, { quoted: msg });
    } catch (e) {
      reply(`❌ Gagal membuat stiker bratvid2: ${e.message}`);
    }
    return;
  }

  if (command === 'animebrat' || command === 'animebrat2') {
    const txt = q || (command === 'animebrat2' ? 'anime brat kawaii' : 'anime brat');
    try {
      const stk = await generateBratCustom({
        text: txt,
        bgColor: command === 'animebrat2' ? '#fdf2f8' : '#fff1f2',
        textColor: '#be185d',
        isAnime: true
      });
      commandExecutedSuccessfully = true;
      await sock.sendMessage(chatId, { sticker: stk }, { quoted: msg });
    } catch (e) {
      reply(`❌ Gagal membuat anime brat: ${e.message}`);
    }
    return;
  }

  if (command === 'ttp') {
    if (!q) return reply(`Masukkan teks untuk stiker TTP!\nContoh: *${config.prefix}ttp Halo Semua*`);
    try {
      const stk = await generateTTP(q);
      commandExecutedSuccessfully = true;
      await sock.sendMessage(chatId, { sticker: stk }, { quoted: msg });
    } catch (e) {
      reply(`❌ Gagal membuat TTP: ${e.message}`);
    }
    return;
  }

  if (command === 'qc' || command === 'qc2') {
    const isQc2 = command === 'qc2';
    let targetText = q;
    let customColor = isQc2 ? '#1e1b4b' : '#1f2c34';

    if (q.includes('|')) {
      const parts = q.split('|').map((s) => s.trim());
      if (parts[0].startsWith('#') || ['red', 'blue', 'green', 'black', 'white', 'purple', 'yellow', 'orange', 'pink'].includes(parts[0].toLowerCase())) {
        customColor = parts[0];
        targetText = parts.slice(1).join(' ');
      }
    } else if (isQc2 && q && !q.includes(' ') && (q.startsWith('#') || ['red', 'blue', 'green', 'black', 'white', 'purple', 'yellow'].includes(q.toLowerCase()))) {
      customColor = q;
      targetText = quoted ? (quoted.conversation || quoted.extendedTextMessage?.text || '') : '';
    }

    if (!targetText && quoted) {
      targetText = quoted.conversation || quoted.extendedTextMessage?.text || quoted.imageMessage?.caption || quoted.videoMessage?.caption || '';
    }

    if (!targetText) {
      return reply(`Masukkan teks quote atau balas pesan dengan *${config.prefix}${command}*!\nContoh: *${config.prefix}qc Halo dunia* atau *${config.prefix}qc #2563eb|Kutipan saya*`);
    }

    try {
      let avatarUrl = '';
      const quotedSender = msg.message?.extendedTextMessage?.contextInfo?.participant;
      const targetJid = quoted ? (quotedSender || sender) : sender;
      try {
        avatarUrl = await sock.profilePictureUrl(targetJid, 'image');
      } catch (_) {}

      const targetName = quoted ? (pushName || 'Anggota') : (pushName || 'Kak');
      const stk = await generateQuoteChat({
        name: targetName,
        text: targetText,
        avatarUrl,
        bgColor: customColor,
        style: isQc2 ? 2 : 1
      });

      commandExecutedSuccessfully = true;
      await sock.sendMessage(chatId, { sticker: stk }, { quoted: msg });
    } catch (e) {
      reply(`❌ Gagal membuat Quote Chat: ${e.message}`);
    }
    return;
  }

  if (command === 'smeme') {
    const targetImage = rawMessage?.imageMessage || quotedMessage?.imageMessage || rawMessage?.stickerMessage || quotedMessage?.stickerMessage;
    if (!targetImage) {
      return reply(`Balas gambar atau stiker dengan *${config.prefix}smeme <teks atas>|<teks bawah>*\nContoh: *${config.prefix}smeme teks atas|teks bawah*`);
    }

    const parts = q.split('|').map((s) => s.trim());
    const top = parts[0] || '';
    const bottom = parts[1] || '';

    if (!top && !bottom) {
      return reply(`Masukkan teks meme!\nContoh: *${config.prefix}smeme ketika tugas selesai|tapi salah matkul*`);
    }

    try {
      const isSticker = Boolean(rawMessage?.stickerMessage || quotedMessage?.stickerMessage);
      const buffer = await getMediaBuffer(targetImage, isSticker ? 'sticker' : 'image');
      const imgBuffer = isSticker ? await webpToImage(buffer) : buffer;
      const memeStk = await generateStickerMeme(imgBuffer, top, bottom);
      commandExecutedSuccessfully = true;
      await sock.sendMessage(chatId, { sticker: memeStk }, { quoted: msg });
    } catch (e) {
      reply(`❌ Gagal membuat sticker meme: ${e.message}`);
    }
    return;
  }

  if (command === 'emojigif') {
    if (!q) return reply(`Masukkan emoji!\nContoh: *${config.prefix}emojigif 😎*`);
    const emojis = q.match(/\p{Emoji}/gu) || [];
    if (emojis.length === 0) return reply('Harap masukkan emoji yang valid!');
    try {
      const code = emojis[0].codePointAt(0).toString(16);
      const url = `https://fonts.gstatic.com/s/e/notoemoji/latest/${code}/512.webp`;
      const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 8000 });
      const stk = await mediaToWebp(res.data, true, config.sticker.packname, config.sticker.author);
      commandExecutedSuccessfully = true;
      await sock.sendMessage(chatId, { sticker: stk }, { quoted: msg });
    } catch (e) {
      reply('❌ Animasi emoji tidak ditemukan atau tidak tersedia.');
    }
    return;
  }

  if (command === 'gifsticker') {
    if (!q) return reply(`Masukkan kata kunci pencarian GIF!\nContoh: *${config.prefix}gifsticker anime dance, 1*`);
    const parts = q.split(',');
    const query = (parts[0] || '').trim();
    const count = Math.min(3, Math.max(1, parseInt(parts[1]) || 1));
    try {
      const gifs = await searchTenor(query, count);
      if (gifs.length === 0) return reply('❌ GIF tidak ditemukan.');
      for (let i = 0; i < Math.min(count, gifs.length); i++) {
        const item = gifs[i];
        const mediaUrl = item.mp4Url || item.gifUrl;
        const res = await axios.get(mediaUrl, { responseType: 'arraybuffer', timeout: 12000 });
        const stk = await mediaToWebp(res.data, true, config.sticker.packname, config.sticker.author);
        await sock.sendMessage(chatId, { sticker: stk }, { quoted: msg });
      }
      commandExecutedSuccessfully = true;
    } catch (e) {
      reply(`❌ Gagal mengambil GIF: ${e.message}`);
    }
    return;
  }

  if (command === 'stly' || command === 'stickerlysearch') {
    if (!q) return reply(`Masukkan kata kunci stiker!\nContoh: *${config.prefix}stly cat lucu*`);
    try {
      const packs = await searchStickerly(q);
      if (!packs || packs.length === 0) return reply('❌ Paket stiker tidak ditemukan di Sticker.ly.');
      const pack = packs[0];
      let sent = 0;
      const stickers = pack.stickers || [];
      for (const s of stickers.slice(0, 3)) {
        const sUrl = s.url || s.stickerUrl;
        if (!sUrl) continue;
        const sRes = await axios.get(sUrl, { responseType: 'arraybuffer', timeout: 10000 });
        const stk = await mediaToWebp(sRes.data, false, pack.name || config.sticker.packname, pack.authorName || config.sticker.author);
        await sock.sendMessage(chatId, { sticker: stk });
        sent++;
      }
      commandExecutedSuccessfully = true;
      if (sent === 0) reply(`📦 Paket ditemukan: *${pack.name}* (${stickers.length} stiker), namun file tidak dapat dimuat.`);
    } catch (e) {
      reply(`❌ Gagal mencari stiker: ${e.message}`);
    }
    return;
  }

  if (command === 'telestick') {
    if (!q) return reply(`Masukkan tautan paket stiker Telegram!\nContoh: *${config.prefix}telestick https://t.me/addstickers/LineFriends*`);
    try {
      const urls = await getTelegramStickers(q);
      if (urls.length === 0) return reply('❌ Paket stiker Telegram tidak ditemukan atau format link tidak sesuai.');
      let sent = 0;
      for (const u of urls.slice(0, 3)) {
        const res = await axios.get(u, { responseType: 'arraybuffer', timeout: 10000 });
        const stk = await mediaToWebp(res.data, false, config.sticker.packname, config.sticker.author);
        await sock.sendMessage(chatId, { sticker: stk });
        sent++;
      }
      commandExecutedSuccessfully = true;
    } catch (e) {
      reply(`❌ Gagal mengunduh stiker Telegram: ${e.message}`);
    }
    return;
  }

  if (command === 'tenor') {
    if (!q) return reply(`Masukkan kata kunci pencarian Tenor!\nContoh: *${config.prefix}tenor cat roll*`);
    try {
      const gifs = await searchTenor(q, 1);
      if (gifs.length === 0) return reply('❌ GIF Tenor tidak ditemukan.');
      const target = gifs[0];
      const res = await axios.get(target.mp4Url || target.gifUrl, { responseType: 'arraybuffer', timeout: 12000 });
      commandExecutedSuccessfully = true;
      await sock.sendMessage(chatId, {
        video: res.data,
        caption: `✨ *Tenor GIF:* ${target.title}`,
        mimetype: 'video/mp4'
      }, { quoted: msg });
    } catch (e) {
      reply(`❌ Gagal mencari Tenor: ${e.message}`);
    }
    return;
  }

  if (command === 'stickersearch') {
    if (!q) return reply(`Masukkan kata kunci stiker!\nContoh: *${config.prefix}stickersearch patrick*`);
    try {
      const pins = await scraper.searchPinterest(q + ' sticker transparent');
      if (pins.length > 0) {
        const imgUrl = pins[0].image;
        const res = await scraper.axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 12000 });
        const stk = await mediaToWebp(res.data, false, config.sticker.packname, config.sticker.author);
        commandExecutedSuccessfully = true;
        await sock.sendMessage(chatId, { sticker: stk }, { quoted: msg });
      } else {
        reply('❌ Stiker tidak ditemukan.');
      }
    } catch (e) {
      reply(`❌ Gagal mencari stiker: ${e.message}`);
    }
    return;
  }

  if (command === 'ryo') {
    try {
      const ryoUrl = getRandomRyo();
      const res = await axios.get(ryoUrl, { responseType: 'arraybuffer', timeout: 10000 });
      const stk = await mediaToWebp(res.data, false, 'Ryo Yamada', 'Bocchi The Rock');
      commandExecutedSuccessfully = true;
      await sock.sendMessage(chatId, { sticker: stk }, { quoted: msg });
    } catch (e) {
      reply(`❌ Gagal: ${e.message}`);
    }
    return;
  }

  if (command === 'tts') {
    if (!q) {
      return reply(
        `Masukkan teks yang ingin diubah menjadi suara!\n\n` +
        `Contoh:\n` +
        `• *${config.prefix}tts Halo, selamat datang di SikanBot*\n` +
        `• *${config.prefix}tts en Good morning everyone*\n` +
        `• *${config.prefix}tts ar Marhaban ya ramadhan*\n` +
        `• *${config.prefix}tts ja Konnichiwa*\n` +
        `• *${config.prefix}tts ko Annyeonghaseyo*`
      );
    }

    let lang = 'id';
    let textToSpeak = q;

    const firstWord = args[0] ? args[0].toLowerCase() : '';
    if (['id', 'en', 'ar', 'ja', 'ko', 'es', 'fr', 'de', 'ru', 'th', 'vi', 'jw', 'su'].includes(firstWord) && args.length > 1) {
      lang = firstWord;
      textToSpeak = args.slice(1).join(' ');
    }

    let tempAudioPath = null;
    let voiceNotePath = null;
    try {
      tempAudioPath = await generateTTS(textToSpeak, lang);
      const vnInfo = await convertToVoiceNote(tempAudioPath);
      voiceNotePath = vnInfo.filePath;
      const audioBuffer = fs.readFileSync(voiceNotePath);

      await sock.sendMessage(chatId, {
        audio: audioBuffer,
        mimetype: vnInfo.mimetype,
        ptt: vnInfo.ptt
      }, { quoted: msg });

      commandExecutedSuccessfully = true;
    } catch (err) {
      console.error('[TTS Error]', err.message);
      reply('❌ Terjadi kesalahan saat memproses Text-To-Speech.');
    } finally {
      if (tempAudioPath) {
        cleanTempAudio(tempAudioPath);
      }
      if (voiceNotePath && voiceNotePath !== tempAudioPath) {
        cleanTempAudio(voiceNotePath);
      }
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
    try {
      const res = await scraper.translateText(textToTrans, lang);
      return reply(`🌐 *TRANSLATE (${lang.toUpperCase()})*\n\n${res}`);
    } catch (e) {
      return reply(`❌ Gagal menerjemahkan: ${e.message}`);
    }
  }

  if (command === 'ssweb') {
    if (!q) return reply(`Masukkan URL website!\nContoh: *${config.prefix}ssweb https://google.com*`);
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

  if (command === 'kan') {
    if (isGroup) {
      await loadGroupInfo();
    }
    const isBotAdminUser = Boolean(userDb && typeof userDb.isBotAdmin === 'function' && userDb.isBotAdmin(sender));
    const isUserAdmin = isAdmin || isBotAdminUser;

    if (!isOwner && !isUserAdmin) {
      return reply('❌ Perintah ini hanya dapat digunakan oleh Admin dan Owner!');
    }

    if (!rawQuotedMessage) {
      return reply('❌ Reply foto/video View Once terlebih dahulu.');
    }

    const vo = extractViewOnceMedia(rawQuotedMessage);
    if (!vo || !vo.isViewOnce) {
      return reply('❌ Pesan yang di-reply bukan View Once.');
    }

    if (!vo.mediaType || !vo.mediaObj) {
      return reply('❌ Gagal mengambil media View Once.');
    }

    try {
      const mediaBuffer = await getMediaBuffer(vo.mediaObj, vo.mediaType);
      if (!mediaBuffer || mediaBuffer.length === 0) {
        return reply('❌ Gagal mengambil media View Once.');
      }

      // Lindungi bot dari file media raksasa (> 100MB)
      const MAX_MEDIA_SIZE = 100 * 1024 * 1024;
      if (mediaBuffer.length > MAX_MEDIA_SIZE) {
        return reply('❌ Ukuran media terlalu besar untuk dikirim.');
      }

      if (vo.mediaType === 'image') {
        await sock.sendMessage(chatId, {
          image: mediaBuffer,
          caption: vo.caption || undefined
        }, { quoted: msg });
      } else if (vo.mediaType === 'video') {
        await sock.sendMessage(chatId, {
          video: mediaBuffer,
          mimetype: vo.mimetype || 'video/mp4',
          caption: vo.caption || undefined
        }, { quoted: msg });
      }

      commandExecutedSuccessfully = true;
    } catch (err) {
      console.error('[KAN Error]', err);
      return reply('❌ Gagal mengambil media View Once.');
    }
    return;
  }

  /* ====================================================================
   * 7. 👥 GROUP (Admin & Moderasi)
   * ==================================================================== */
  if (['add', 'kick', 'promote', 'demote', 'tagall', 'hidetag', 'groupinfo', 'linkgroup', 'revoke', 'open', 'close', 'warn', 'antilink', 'antispam', 'welcome'].includes(command)) {
    if (!isGroup) return reply('Perintah ini hanya dapat digunakan di dalam grup!');

    await loadGroupInfo(true);

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
      try {
        const { participants: validList } = await getValidGroupParticipants(sock, chatId);
        let text = `📢 *TAG ALL MEMBERS*\n${q ? `Pesan: *${q}*\n` : ''}\n`;
        validList.forEach((jid, i) => {
          const num = jid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
          text += `${i + 1}. @${num}\n`;
        });
        commandExecutedSuccessfully = true;
        return await sock.sendMessage(chatId, { text, mentions: validList });
      } catch (err) {
        return reply(err.message || '❌ Gagal mengambil daftar anggota grup terbaru.');
      }
    }

    if (command === 'hidetag') {
      try {
        const { participants: validList } = await getValidGroupParticipants(sock, chatId);
        const text = q || '📢 PENGUMUMAN GRUP';
        commandExecutedSuccessfully = true;
        return await sock.sendMessage(chatId, { text, mentions: validList });
      } catch (err) {
        return reply(err.message || '❌ Gagal mengambil daftar anggota grup terbaru.');
      }
    }

    if (command === 'open') {
      if (!isBotAdmin) {
        return reply('❌ Bot harus menjadi admin untuk menjalankan command ini.');
      }
      await sock.groupSettingUpdate(chatId, 'not_announcement');
      commandExecutedSuccessfully = true;
      return reply('🔓 Grup telah dibuka! Semua anggota dapat mengirim pesan.');
    }

    if (command === 'close') {
      if (!isBotAdmin) {
        return reply('❌ Bot harus menjadi admin untuk menjalankan command ini.');
      }
      await sock.groupSettingUpdate(chatId, 'announcement');
      commandExecutedSuccessfully = true;
      return reply('🔒 Grup telah ditutup! Hanya admin yang dapat mengirim pesan.');
    }

    if (command === 'linkgroup') {
      if (!isBotAdmin) return reply('❌ Bot harus menjadi admin untuk menjalankan command ini.');
      try {
        const code = await sock.groupInviteCode(chatId);
        commandExecutedSuccessfully = true;
        return reply(`🔗 *Tautan Undangan Grup:*\nhttps://chat.whatsapp.com/${code}`);
      } catch (e) {
        return reply('Gagal mengambil tautan undangan.');
      }
    }

    if (command === 'revoke') {
      if (!isBotAdmin) return reply('❌ Bot harus menjadi admin untuk menjalankan command ini.');
      try {
        await sock.groupRevokeInvite(chatId);
        commandExecutedSuccessfully = true;
        return reply('✅ Tautan undangan grup berhasil direset.');
      } catch (e) {
        return reply('Gagal mereset tautan undangan.');
      }
    }

    if (command === 'antilink') {
      const val = !db.getGroup(chatId).antilink;
      db.updateGroup(chatId, { antilink: val });
      commandExecutedSuccessfully = true;
      return reply(`🛡️ *Anti Link* sekarang telah di-${val ? 'AKTIFKAN 🟢' : 'NONAKTIFKAN 🔴'}`);
    }

    if (command === 'antispam') {
      const val = !db.getGroup(chatId).antispam;
      db.updateGroup(chatId, { antispam: val });
      commandExecutedSuccessfully = true;
      return reply(`🛡️ *Anti Spam* sekarang telah di-${val ? 'AKTIFKAN 🟢' : 'NONAKTIFKAN 🔴'}`);
    }

    if (command === 'welcome') {
      const val = !db.getGroup(chatId).welcome;
      db.updateGroup(chatId, { welcome: val });
      commandExecutedSuccessfully = true;
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
          commandExecutedSuccessfully = true;
          return reply(`⚠️ @${target.split('@')[0]} telah menerima 3 peringatan dan dikeluarkan dari grup!`, { skipAutoMention: true });
        } else {
          return reply(`⚠️ @${target.split('@')[0]} telah menerima 3 peringatan (Bot bukan admin untuk kick).`);
        }
      } else {
        return reply(`⚠️ Peringatan untuk @${target.split('@')[0]} (${warns}/3). Hati-hati!`);
      }
    }

    if (!isBotAdmin) {
      return reply('❌ Bot harus menjadi admin untuk menjalankan command ini.');
    }

    const target = msg.message?.extendedTextMessage?.contextInfo?.participant
      || (args[0] ? args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : null);

    if (!target) return reply('Balas pesan member yang dituju atau masukkan nomornya!');

    if (command === 'kick') {
      await sock.groupParticipantsUpdate(chatId, [target], 'remove');
      groupCache.delete(chatId);
      commandExecutedSuccessfully = true;
      const targetNum = target.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
      return reply(`👢 @${targetNum} telah dikeluarkan dari grup.`, { skipAutoMention: true });
    }

    if (command === 'add') {
      await sock.groupParticipantsUpdate(chatId, [target], 'add');
      groupCache.delete(chatId);
      commandExecutedSuccessfully = true;
      return reply(`✅ Berhasil menambahkan @${target.split('@')[0]} ke grup.`);
    }

    if (command === 'promote') {
      await sock.groupParticipantsUpdate(chatId, [target], 'promote');
      groupCache.delete(chatId);
      commandExecutedSuccessfully = true;
      return reply(`👑 @${target.split('@')[0]} sekarang menjadi Admin Grup!`);
    }

    if (command === 'demote') {
      await sock.groupParticipantsUpdate(chatId, [target], 'demote');
      groupCache.delete(chatId);
      commandExecutedSuccessfully = true;
      return reply(`📉 @${target.split('@')[0]} telah diturunkan menjadi member biasa.`);
    }
  }

  /* ====================================================================
   * 8. 👑 OWNER
   * ==================================================================== */
  if (['addprem', 'delprem', 'listprem', 'ban', 'unban', 'block', 'unblock', 'broadcast', 'join', 'leave', 'restart', 'shutdown'].includes(command)) {
    if (!isOwner) return reply('❌ Perintah ini khusus untuk *Owner Bot (Rahmat Haikal)*!');

    if (command === 'addprem') {
      const target = normalizePhoneNumber(args[0]) || (quoted ? getQuotedPhoneNumber(msg, sock, groupMetadata) : null);
      if (!target) return reply(`Masukkan nomor user atau balas pesan chat user!\nContoh: *${config.prefix}addprem 62822xxx*`);
      db.updateUser(target, { premium: true });
      return reply(`⭐ User ${formatPhoneDisplay(target)} berhasil ditambahkan ke daftar Premium!`);
    }

    if (command === 'delprem') {
      const target = normalizePhoneNumber(args[0]) || (quoted ? getQuotedPhoneNumber(msg, sock, groupMetadata) : null);
      if (!target) return reply(`Masukkan nomor user atau balas pesan chat user!\nContoh: *${config.prefix}delprem 62822xxx*`);
      db.updateUser(target, { premium: false });
      return reply(`User ${formatPhoneDisplay(target)} telah dihapus dari Premium.`);
    }

    if (command === 'listprem') {
      const users = db.data.users || {};
      const prems = Object.keys(users).filter((k) => users[k].premium);
      if (prems.length === 0) return reply('Belum ada user premium.');
      let out = `👑 *DAFTAR USER PREMIUM (${prems.length})*\n\n`;
      prems.forEach((p, i) => { out += `${i + 1}. ${formatPhoneDisplay(p)}\n`; });
      return reply(out);
    }

    if (command === 'ban') {
      const target = normalizePhoneNumber(args[0]) || (quoted ? getQuotedPhoneNumber(msg, sock, groupMetadata) : null);
      if (!target) return reply(`Masukkan nomor yang ingin diban atau balas pesan chat user!\nContoh: *${config.prefix}ban 628xxx*`);
      db.updateUser(target, { banned: true });
      return reply(`🚫 User ${formatPhoneDisplay(target)} telah dibanned dari bot!`);
    }

    if (command === 'unban') {
      const target = normalizePhoneNumber(args[0]) || (quoted ? getQuotedPhoneNumber(msg, sock, groupMetadata) : null);
      if (!target) return reply(`Masukkan nomor yang ingin di-unban atau balas pesan chat user!\nContoh: *${config.prefix}unban 628xxx*`);
      db.updateUser(target, { banned: false });
      return reply(`✅ User ${formatPhoneDisplay(target)} telah di-unban.`);
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
   * 8.1. 🗄️ ADMIN USER DATABASE & MANAGEMENT
   * ==================================================================== */
  if (['addadmin', 'deladmin', 'listadmin', 'daftaruser', 'deluser', 'users', 'listuser', 'infouser', 'userinfo', 'resetlimit', 'setunlimited', 'setlimit', 'addprem', 'delprem', 'listprem'].includes(command)) {
    const isBotAdminUser = isOwner || userDb.isBotAdmin(sender);

    // addadmin & deladmin khusus Owner
    if (['addadmin', 'deladmin'].includes(command)) {
      if (!isOwner) return reply('❌ Perintah ini khusus untuk *Owner Bot (Rahmat Haikal)*!');
      const target = normalizePhoneNumber(args[0]) || (quoted ? getQuotedPhoneNumber(msg, sock, groupMetadata) : null);
      if (!target || !isValidPhoneNumber(target)) return reply(`Masukkan nomor yang dituju atau balas pesan chat user!\nContoh: *${config.prefix}${command} 62822xxx*`);

      if (command === 'addadmin') {
        userDb.addBotAdmin(target);
        commandExecutedSuccessfully = true;
        return reply(`👑 Berhasil mengangkat ${formatPhoneDisplay(target)} sebagai *Admin Bot*! Sekarang user ini memiliki akses kelola user & bebas limit.`);
      }

      if (command === 'deladmin') {
        userDb.removeBotAdmin(target);
        commandExecutedSuccessfully = true;
        return reply(`✅ Berhasil mencabut hak Admin Bot dari ${formatPhoneDisplay(target)}.`);
      }
    }

    // Command lainnya bisa diakses oleh Owner & Admin Bot
    if (!isBotAdminUser) return reply('❌ Perintah ini khusus untuk *Admin Bot & Owner*!');

    if (command === 'listadmin') {
      const admins = userDb.listBotAdmins();
      let text = `👑 *DAFTAR ADMIN BOT*\n\n• Owner: +${config.owner.number.replace(/[^0-9]/g, '')} (${config.owner.name})\n`;
      if (admins.length === 0) {
        text += '\n_Belum ada admin tambahan._';
      } else {
        admins.forEach((a, i) => {
          text += `${i + 1}. ${formatPhoneDisplay(a.phone)} ${a.name ? `(${a.name})` : ''}\n`;
        });
      }
      commandExecutedSuccessfully = true;
      return reply(text.trim());
    }

    if (command === 'addprem') {
      let target = null;
      let durArg = '30d';

      const quotedNum = getQuotedPhoneNumber(msg, sock, groupMetadata);
      if (quotedNum && (!botNumber || quotedNum !== botNumber)) {
        target = quotedNum;
        durArg = args[0] || '30d';
      } else {
        target = normalizePhoneNumber(args[0]);
        durArg = args[1] || '30d';
      }

      if (!target || !isValidPhoneNumber(target)) {
        return reply(
          `👑 *PANDUAN MENAMBAH PREMIUM*\n\n` +
          `Format:\n` +
          `• Balas pesan user: *${config.prefix}addprem [7d|30d]*\n` +
          `• Atau ketik nomor: *${config.prefix}addprem <nomor> [7d|30d]*\n\n` +
          `Pilihan Paket:\n` +
          `• *7d*  : 7 Hari (Rp5.000)\n` +
          `• *30d* : 30 Hari (Rp10.000)\n\n` +
          `Contoh: *${config.prefix}addprem 628123456789 30d*`
        );
      }

      const is7Days = /^7d?$|^7hari$/i.test(durArg);
      const days = is7Days ? 7 : 30;
      const pkgName = is7Days ? '7 Hari (Rp5.000)' : '30 Hari (Rp10.000)';

      const updated = userDb.addPremium(target, pkgName, days);
      const expDate = updated?.premium_expires_at ? new Date(updated.premium_expires_at).toLocaleDateString('id-ID') : '-';

      // Kirim notifikasi ucapan ke user
      try {
        const targetJid = `${target}@s.whatsapp.net`;
        await sock.sendMessage(targetJid, {
          text: `🎉 *SELAMAT! AKUN PREMIUM DIAKTIFKAN* 🎉\n\n` +
            `Halo kak, akun Anda telah berhasil diupgrade ke *Premium SikanBot* oleh Admin/Owner!\n\n` +
            `• Paket       : ${pkgName}\n` +
            `• Durasi      : ${days} Hari\n` +
            `• Kedaluwarsa : ${expDate}\n` +
            `• Kuota       : UNLIMITED ♾️ (Bebas limit harian)\n\n` +
            `Terima kasih telah berlangganan! Selamat menggunakan seluruh fitur bot tanpa batas.`
        });
      } catch (_) {}

      commandExecutedSuccessfully = true;
      return reply(
        `👑 *BERHASIL MENAMBAHKAN USER PREMIUM*\n\n` +
        `• Nomor       : ${formatPhoneDisplay(target)}\n` +
        `• Paket       : ${pkgName}\n` +
        `• Durasi      : ${days} Hari\n` +
        `• Kedaluwarsa : ${expDate}\n` +
        `• Kuota       : Unlimited ♾️\n\n` +
        `User ini sekarang bebas limit harian.`
      );
    }

    if (command === 'delprem') {
      const target = normalizePhoneNumber(args[0]) || (quoted ? getQuotedPhoneNumber(msg, sock, groupMetadata) : null);
      if (!target || !isValidPhoneNumber(target)) {
        return reply(`Masukkan nomor yang dituju atau balas pesan chat user!\nContoh: *${config.prefix}delprem 62822xxx*`);
      }

      userDb.removePremium(target);
      commandExecutedSuccessfully = true;
      return reply(`✅ Berhasil mencabut status Premium dari ${formatPhoneDisplay(target)}. Status akun dikembalikan ke reguler.`);
    }

    if (command === 'listprem') {
      const prems = userDb.listPremiumUsers();
      if (!prems || prems.length === 0) {
        return reply('👑 *DAFTAR USER PREMIUM*\n\n_Belum ada user premium yang terdaftar._');
      }

      let text = `👑 *DAFTAR USER PREMIUM (${prems.length})*\n\n`;
      prems.forEach((p, i) => {
        const expStr = p.premium_expires_at ? new Date(p.premium_expires_at).toLocaleDateString('id-ID') : '-';
        text += `${i + 1}. ${p.name || 'User'} (${formatPhoneDisplay(p.phone)})\n`;
        text += `   └ Paket: ${p.premium_package || '-'} | Sisa: ${p.remainingDays} hari (s/d ${expStr})\n`;
      });
      commandExecutedSuccessfully = true;
      return reply(text.trim());
    }

    if (command === 'daftaruser') {
      let targetNum = null;
      let targetName = null;

      // Cek apakah admin me-reply chat user
      const quotedNum = getQuotedPhoneNumber(msg, sock, groupMetadata);
      if (quotedNum && (!botNumber || quotedNum !== botNumber)) {
        targetNum = quotedNum;
        targetName = q.trim();
      }

      if (!targetNum && q && q.includes('|')) {
        const parts = q.split('|').map((s) => s.trim());
        targetNum = normalizePhoneNumber(parts[0]);
        targetName = parts[1] || '';
      }

      if (!targetNum || !isValidPhoneNumber(targetNum) || !targetName) {
        return reply(
          `Format pendaftaran user oleh admin:\n` +
          `• Balas pesan user lalu ketik: *${config.prefix}daftaruser <nama lengkap>*\n` +
          `• Atau ketik: *${config.prefix}daftaruser <nomor>|<nama lengkap>*\n` +
          `Contoh: *${config.prefix}daftaruser 628123456789|Ahmad Fauzi*`
        );
      }

      userDb.adminRegisterUser(targetNum, targetName);
      commandExecutedSuccessfully = true;
      return reply(
        `✅ *REGISTRASI USER BERHASIL (BY ADMIN)*\n\n` +
        `• Nama   : ${targetName}\n` +
        `• Nomor  : ${formatPhoneDisplay(targetNum)}\n` +
        `• Status : UNLIMITED ♾️\n\n` +
        `User berhasil didaftarkan dan mendapatkan akses tanpa batas.`
      );
    }

    if (command === 'deluser') {
      const rawTargets = q.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
      if (rawTargets.length === 0) {
        return reply(`Masukkan ID atau nomor user yang ingin dihapus!\nContoh:\n• *${config.prefix}deluser 5*\n• *${config.prefix}deluser 2, 3, 5* (Hapus & broadcast beberapa user)`);
      }

      const deletedUsers = [];
      const notFoundTargets = [];

      for (const target of rawTargets) {
        const targetId = parseInt(target, 10);
        let u = null;
        if (!isNaN(targetId) && targetId < 100000) {
          u = userDb.getUserById(targetId);
        }
        if (!u) {
          const cleanPhone = normalizeUserNumber(target);
          if (cleanPhone) {
            u = userDb.getUser(cleanPhone);
          }
        }

        if (u) {
          const ok = userDb.deleteUserById(u.id);
          if (ok) {
            if (u.phone && db.data?.users?.[u.phone]) {
              delete db.data.users[u.phone];
              db.save();
            }

            // Siarkan notifikasi penghapusan akun ke WhatsApp user
            let notified = false;
            try {
              const userJid = u.jid || `${u.phone}@s.whatsapp.net`;
              await sock.sendMessage(userJid, {
                text: `⚠️ *PEMBERITAHUAN SIKANBOT*\n\nAkun Anda (*#${u.id} - ${u.name}*) telah dinonaktifkan/dihapus dari sistem SikanBot oleh Admin/Owner.\n\nJika ingin menggunakan bot kembali dengan akses penuh, silakan lakukan pendaftaran ulang dengan perintah:\n*${config.prefix}daftar Nama - Kota - Umur*`
              });
              notified = true;
            } catch (_) {}

            deletedUsers.push({
              id: u.id,
              name: u.name,
              phone: u.phone,
              notified
            });
          } else {
            notFoundTargets.push(target);
          }
        } else {
          notFoundTargets.push(target);
        }
      }

      if (deletedUsers.length === 0) {
        return reply(`❌ Tidak ada user yang ditemukan untuk ID/nomor: ${notFoundTargets.join(', ')}.`);
      }

      commandExecutedSuccessfully = true;

      if (rawTargets.length === 1 && deletedUsers.length === 1) {
        const u = deletedUsers[0];
        const bcStatus = u.notified ? '\n📢 Notifikasi telah disiarkan ke WhatsApp user.' : '';
        return reply(`🗑️ Data user #${u.id} (${u.name}) berhasil dihapus dari database.${bcStatus}`);
      }

      let out = `🗑️ *HASIL PENGHAPUSAN USER (MULTI / BROADCAST)*\n\n` +
        `✅ *Berhasil Dihapus (${deletedUsers.length} user):*\n`;
      deletedUsers.forEach((u) => {
        const statusNotif = u.notified ? '📢 [Tersiar]' : '⚠️ [Gagal Notif]';
        out += `• #${u.id} - ${u.name} (${formatPhoneDisplay(u.phone)}) ${statusNotif}\n`;
      });

      if (notFoundTargets.length > 0) {
        out += `\n❌ *Tidak Ditemukan (${notFoundTargets.length}):* ${notFoundTargets.join(', ')}\n`;
      }

      out += `\nTotal: ${deletedUsers.length} user dihapus & disiarkan.`;
      return reply(out);
    }

    if (command === 'listuser') {
      const usersList = userDb.getAllRegisteredUsers();
      if (!usersList || usersList.length === 0) {
        return reply(`👥 *DAFTAR USER*\n\n_Belum ada user yang terdaftar._\n\nTotal User: 0`);
      }
      let txt = `👥 *DAFTAR USER*\n\n`;
      usersList.forEach((u) => {
        const paddedId = String(u.id).padStart(2, '0');
        txt += `${paddedId}. ${u.name}\n`;
      });
      txt += `\nTotal User: ${usersList.length}`;
      commandExecutedSuccessfully = true;
      return reply(txt);
    }

    if (command === 'infouser') {
      const targetId = parseInt(args[0], 10);
      if (isNaN(targetId)) {
        return reply(`Masukkan ID user!\nContoh: *${config.prefix}infouser 1*`);
      }
      const u = userDb.getUserById(targetId);
      if (!u) {
        return reply(`❌ User dengan ID ${targetId} tidak ditemukan.`);
      }

      const registeredDate = userDb.formatIndonesianDate(u.registered_at || u.created_at);
      const isUnlim = (u.unlimited === 1 || u.limit_type === 'unlimited' || u.premium === 1);
      const maxLimit = isUnlim ? 'Unlimited' : (u.registered === 1 ? 30 : 10);
      const hitsToday = u.hits_today || 0;
      const remainingLimit = isUnlim ? 'Unlimited' : Math.max(0, maxLimit - hitsToday);

      const card = `👤 *INFORMASI USER*\n\n` +
        `🆔 ID          : ${u.id}\n` +
        `👤 Nama        : ${u.name}\n` +
        `📍 Kota        : ${u.kota || '-'}\n` +
        `🎂 Umur        : ${u.umur || '-'}\n` +
        `📱 Nomor       : ${u.phone}\n` +
        `📅 Terdaftar   : ${registeredDate}\n` +
        `🟢 Status      : ${u.status || 'Aktif'}\n` +
        `👑 Premium     : ${u.premium === 1 ? `Ya (${u.premium_package || '-'})` : 'Tidak'}\n` +
        `📊 Limit Harian: ${maxLimit}\n` +
        `📥 Hit Hari Ini: ${hitsToday}\n` +
        `📈 Sisa Limit  : ${remainingLimit}`;

      commandExecutedSuccessfully = true;
      return reply(card);
    }

    if (command === 'users') {
      const pageArg = args[0] ? parseInt(args[0]) : null;
      const isList = args[0] === 'list' || (!isNaN(pageArg) && pageArg !== null);

      if (isList) {
        const page = (args[0] === 'list' && args[1]) ? (parseInt(args[1]) || 1) : (pageArg || 1);
        const data = userDb.getUsersPage(page, 10);
        if (!data.users || data.users.length === 0) {
          return reply(`Halaman ${page} tidak ditemukan (total ${data.totalPages} halaman).`);
        }
        let txt = `╭───〔 👥 DAFTAR USER (Hal ${data.page}/${data.totalPages}) 〕\n│\n`;
        data.users.forEach((u, i) => {
          const num = ((data.page - 1) * data.pageSize) + (i + 1);
          const roleBadge = u.role === 'owner' ? ' [OWNER]' : (u.role === 'admin' ? ' [ADMIN]' : (u.premium ? ' [PREMIUM]' : ''));
          const limText = (u.unlimited || u.limit_type === 'unlimited' || u.premium) ? 'UNLIMITED' : `HITS: ${u.hits_today || 0}/${u.registered ? 30 : 10}`;
          txt += `├ ${num}. ${u.name || 'User'} (${formatPhoneDisplay(u.phone)})${roleBadge}\n│  └ Status: ${limText} | Cmd: ${u.total_commands || 0}\n`;
        });
        txt += `╰────────────────\n• Total User: ${data.total}\n• Ketik *${config.prefix}listuser ${data.page + 1}* untuk halaman berikutnya.`;
        commandExecutedSuccessfully = true;
        return reply(txt);
      }

      const ov = userDb.getUsersOverview();
      const summaryText = `╭───〔 👥 USER DATABASE 〕
│
├ Total User   : ${ov.total.toLocaleString('id-ID')}
├ Registered   : ${ov.registered.toLocaleString('id-ID')}
├ Premium      : ${ov.premium.toLocaleString('id-ID')}
├ Unlimited    : ${ov.unlimited.toLocaleString('id-ID')}
├ Banned       : ${ov.banned.toLocaleString('id-ID')}
├ Active Today : ${ov.activeToday.toLocaleString('id-ID')}
╰────────────────
Gunakan *${config.prefix}listuser* atau *${config.prefix}users list* untuk melihat daftar pengguna.`;

      commandExecutedSuccessfully = true;
      return reply(summaryText);
    }

    if (command === 'userinfo') {
      const target = normalizePhoneNumber(args[0]) || (quoted ? getQuotedPhoneNumber(msg, sock, groupMetadata) : null);
      if (!target || !isValidPhoneNumber(target)) return reply(`Masukkan nomor pengguna yang valid atau balas pesan chat user!\nContoh: *${config.prefix}userinfo 62822xxx*`);
      const info = userDb.getUserInfo(target);
      if (!info) return reply('❌ Pengguna tidak ditemukan di database.');

      const limitCheck = checkUserLimit(info.jid, isOwner, false);
      const isReg = info.registered === 1 ? 'Yes' : 'No';
      const isPrem = info.premium === 1 ? 'Yes' : 'No';
      const isUnlim = (info.limit_type === 'unlimited' || info.unlimited === 1 || info.premium === 1) ? 'Yes' : 'No';
      const limitVal = isUnlim === 'Yes' ? 'Unlimited' : `${info.hits_today || 0}/${limitCheck.maxLimit} (Sisa: ${limitCheck.remaining})`;
      const firstSeen = info.created_at ? new Date(info.created_at).toLocaleDateString('id-ID') : '-';
      const lastSeen = info.updated_at ? new Date(info.updated_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '-';
      const lastCmd = info.last_command ? `.${info.last_command}` : '-';

      const infoText = `╭───〔 👤 USER INFORMATION 〕
│
├ Name       : ${info.name || '-'}
├ Number     : ${formatPhoneDisplay(info.phone || target)}
├ ID         : ${info.id || '-'}
├ Registered : ${isReg}
├ Role       : ${info.is_admin ? 'Admin Bot' : (info.role || 'User')}
├ Premium    : ${isPrem}${info.premium === 1 ? ` (${info.premium_package || 'Premium'})` : ''}
├ Unlimited  : ${isUnlim}
├ Limit Hari : ${limitVal}
├ Commands   : ${(info.total_commands || 0).toLocaleString('id-ID')}
├ Success    : ${(info.success_commands || 0).toLocaleString('id-ID')}
├ Failed     : ${(info.failed_commands || 0).toLocaleString('id-ID')}
├ First Seen : ${firstSeen}
├ Last Seen  : ${lastSeen}
├ Last Cmd   : ${lastCmd}
╰────────────────`;

      commandExecutedSuccessfully = true;
      return reply(infoText);
    }

    if (command === 'resetlimit') {
      const target = normalizePhoneNumber(args[0]) || (quoted ? getQuotedPhoneNumber(msg, sock, groupMetadata) : null);
      if (!target || !isValidPhoneNumber(target)) return reply(`Masukkan nomor pengguna yang valid atau balas pesan chat user!\nContoh: *${config.prefix}resetlimit 62822xxx*`);
      const ok = userDb.resetLimit(target);
      if (ok) {
        commandExecutedSuccessfully = true;
        return reply(`✅ Limit penggunaan untuk ${formatPhoneDisplay(target)} berhasil direset menjadi 0.`);
      } else {
        return reply('❌ Pengguna tidak ditemukan atau gagal mereset limit.');
      }
    }

    if (command === 'setunlimited') {
      const target = normalizePhoneNumber(args[0]) || (quoted ? getQuotedPhoneNumber(msg, sock, groupMetadata) : null);
      if (!target || !isValidPhoneNumber(target)) return reply(`Masukkan nomor pengguna yang valid atau balas pesan chat user!\nContoh: *${config.prefix}setunlimited 62822xxx*`);
      userDb.setUnlimited(target);
      commandExecutedSuccessfully = true;
      return reply(`✅ Berhasil mengubah status pengguna ${formatPhoneDisplay(target)} menjadi UNLIMITED.`);
    }

    if (command === 'setlimit') {
      const target = normalizePhoneNumber(args[0]) || (quoted ? getQuotedPhoneNumber(msg, sock, groupMetadata) : null);
      if (!target || !isValidPhoneNumber(target)) return reply(`Masukkan nomor pengguna yang valid atau balas pesan chat user!\nContoh: *${config.prefix}setlimit 62822xxx*`);
      userDb.setLimit(target);
      commandExecutedSuccessfully = true;
      return reply(`✅ Berhasil mengembalikan status pengguna ${formatPhoneDisplay(target)} menjadi LIMITED (10 hit/hari guest, 30 hit/hari terdaftar).`);
    }
  }

  /* ====================================================================
   * 9. 🤖 AI
   * ==================================================================== */
  if (command === 'ai' || command === 'ask') {
    if (!q) return reply(`Halo! Tanyakan apa saja kepada AI.\nContoh: *${config.prefix}ai Jelaskan cara kerja jaringan internet secara sederhana*`);
    try {
      const answer = await scraper.askAI(q);
      return reply(answer);
    } catch (e) {
      return reply(`❌ ${e.message}`);
    }
  }

  if (command === 'imagine') {
    if (!q) return reply(`Masukkan prompt deskripsi gambar!\nContoh: *${config.prefix}imagine cybernetic futuristic cat with neon lights, 4k ultra detailed*`);
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
    try {
      const summary = await scraper.askAI(textToSum, 'Tolong buat rangkuman inti poin penting yang padat, jelas, dan rapi dalam bahasa Indonesia.');
      return reply(`📑 *RANGKUMAN TEKS*\n\n${summary}`);
    } catch (e) {
      return reply(`❌ Gagal merangkum: ${e.message}`);
    }
  }

  /* ====================================================================
   * 10. 📊 LOG & MONITORING & STATS
   * ==================================================================== */
  if (command === 'stats') {
    let groupCount = 0;
    try {
      if (sock.groupFetchAllParticipating) {
        const groups = await sock.groupFetchAllParticipating();
        groupCount = Object.keys(groups || {}).length;
      }
    } catch (_) {}

    const uptimeStr = formatUptime(Math.floor((Date.now() - startTime) / 1000));
    const st = userDb.getBotStats(uptimeStr, groupCount);

    const statsText = `╭───〔 📊 BOT STATISTICS 〕
│
├ Uptime       : ${st.uptime}
├ Users        : ${st.users.toLocaleString('id-ID')}
├ Groups       : ${st.groups.toLocaleString('id-ID')}
├ Commands     : ${st.commands.toLocaleString('id-ID')}
├ Success      : ${st.success.toLocaleString('id-ID')}
├ Failed       : ${st.failed.toLocaleString('id-ID')}
├ Downloads    : ${st.downloads.toLocaleString('id-ID')}
├ Stickers     : ${st.stickers.toLocaleString('id-ID')}
├ TTS          : ${st.tts.toLocaleString('id-ID')}
╰────────────────`;

    commandExecutedSuccessfully = true;
    return reply(statsText);
  }

  if (['logs', 'loguser', 'logcmd', 'logerror', 'logdownload', 'loggroup'].includes(command)) {
    if (!isOwner && !isBotAdmin) {
      return reply('🚫 Perintah log dan monitoring hanya dapat diakses oleh Admin Bot atau Owner!');
    }

    if (command === 'logs') {
      const limit = parseInt(args[0]) || 10;
      const logs = userDb.getRecentLogs(Math.min(limit, 25));
      if (!logs || logs.length === 0) return reply('📋 Belum ada catatan log command.');

      let txt = `📊 *LOG COMMAND TERAKHIR (${logs.length})*\n\n`;
      logs.forEach((l, i) => {
        const time = new Date(l.timestamp).toLocaleTimeString('id-ID', { hour12: false });
        txt += `${i + 1}. [${time}] *${l.command}* by ${formatPhoneDisplay(l.number)} [${l.status}]${l.error ? `\n   ⚠️ Error: ${l.error}` : ''}\n`;
      });
      commandExecutedSuccessfully = true;
      return reply(txt.trim());
    }

    if (command === 'loguser') {
      const target = normalizePhoneNumber(args[0]) || (quoted ? getQuotedPhoneNumber(msg, sock, groupMetadata) : null);
      if (!target) return reply(`Masukkan nomor user atau balas pesan chat user!\nContoh: *${config.prefix}loguser 62822xxx*`);
      const logs = userDb.getLogsByUser(target, 15);
      if (!logs || logs.length === 0) return reply(`📋 Tidak ada log untuk user ${formatPhoneDisplay(target)}.`);

      let txt = `👤 *LOG AKTIVITAS USER ${formatPhoneDisplay(target)}*\n\n`;
      logs.forEach((l, i) => {
        const time = new Date(l.timestamp).toLocaleTimeString('id-ID', { hour12: false });
        txt += `${i + 1}. [${time}] .${l.command} ${l.arguments ? `"${l.arguments.slice(0, 30)}"` : ''} [${l.status}]\n`;
      });
      commandExecutedSuccessfully = true;
      return reply(txt.trim());
    }

    if (command === 'logcmd') {
      const cmdName = (args[0] || '').toLowerCase().replace(/^[./!]/, '');
      if (!cmdName) return reply(`Masukkan nama command!\nContoh: *${config.prefix}logcmd play*`);
      const logs = userDb.getLogsByCommand(cmdName, 15);
      if (!logs || logs.length === 0) return reply(`📋 Tidak ada log untuk command .${cmdName}.`);

      let txt = `⌨️ *LOG COMMAND .${cmdName}*\n\n`;
      logs.forEach((l, i) => {
        const time = new Date(l.timestamp).toLocaleTimeString('id-ID', { hour12: false });
        txt += `${i + 1}. [${time}] ${formatPhoneDisplay(l.number)} [${l.status}] ${l.error ? `(${l.error})` : ''}\n`;
      });
      commandExecutedSuccessfully = true;
      return reply(txt.trim());
    }

    if (command === 'logerror') {
      const logs = userDb.getErrorLogs(15);
      if (!logs || logs.length === 0) return reply('✅ Tidak ada riwayat command yang error.');

      let txt = `⚠️ *LOG COMMAND GAGAL / ERROR*\n\n`;
      logs.forEach((l, i) => {
        const time = new Date(l.timestamp).toLocaleTimeString('id-ID', { hour12: false });
        txt += `${i + 1}. [${time}] .${l.command} by ${formatPhoneDisplay(l.number)}\n   ❌ Error: ${l.error || 'Unknown'}\n`;
      });
      commandExecutedSuccessfully = true;
      return reply(txt.trim());
    }

    if (command === 'logdownload') {
      const logs = userDb.getDownloadLogs(15);
      if (!logs || logs.length === 0) return reply('📋 Belum ada riwayat aktivitas download.');

      let txt = `📥 *LOG AKTIVITAS DOWNLOAD*\n\n`;
      logs.forEach((l, i) => {
        const time = new Date(l.timestamp).toLocaleTimeString('id-ID', { hour12: false });
        txt += `${i + 1}. [${time}] .${l.command} ${l.arguments ? `(${l.arguments.slice(0, 30)})` : ''} by ${formatPhoneDisplay(l.number)} [${l.status}]\n`;
      });
      commandExecutedSuccessfully = true;
      return reply(txt.trim());
    }

    if (command === 'loggroup') {
      const logs = userDb.getGroupLogs(15);
      if (!logs || logs.length === 0) return reply('📋 Belum ada log aktivitas dari grup.');

      let txt = `👥 *LOG AKTIVITAS GRUP*\n\n`;
      logs.forEach((l, i) => {
        const time = new Date(l.timestamp).toLocaleTimeString('id-ID', { hour12: false });
        txt += `${i + 1}. [${time}] [${l.group_name || 'Grup'}] .${l.command} by ${formatPhoneDisplay(l.number)} [${l.status}]\n`;
      });
      commandExecutedSuccessfully = true;
      return reply(txt.trim());
    }
  }
  } catch (err) {
    commandHasFailed = true;
    lastCommandError = err.message || 'Error tidak diketahui';
    console.error(`[Command Error: ${command}]`, err);
    try {
      await reply(`❌ Terjadi kesalahan pada bot: ${err.message || 'Error tidak diketahui'}`);
    } catch (_) {}
  } finally {
    if (commandExecutedSuccessfully && isLimitedCmd && !commandHasFailed) {
      consumeUserLimit(sender, isOwner, isGroup);
    }
    const isSuccess = !commandHasFailed;
    await stopProcessing(sock, msg, isSuccess);

    // Command Logging (Pencatatan Log Eksekusi ke SQLite)
    try {
      const execTimeSec = ((Date.now() - cmdStartTime) / 1000).toFixed(2);
      const logStatus = isSuccess ? 'SUCCESS' : 'FAILED';
      const errorMsg = !isSuccess ? (lastCommandError || 'Command error') : null;

      userDb.logCommand({
        timestamp: Date.now(),
        userId: sender,
        number: senderNumber,
        username: pushName || '',
        command: command,
        arguments: q || '',
        chatType: isGroup ? 'group' : 'private',
        chatId: chatId,
        groupName: isGroup ? groupName : '',
        status: logStatus,
        executionTime: parseFloat(execTimeSec),
        error: errorMsg
      });

      const timeStr = new Date().toLocaleTimeString('id-ID', { hour12: false });
      console.log(
        `\n[${timeStr}]\n` +
        `USER    : ${senderNumber}\n` +
        `NAME    : ${pushName || '-'}\n` +
        `COMMAND : .${command}\n` +
        `ARGS    : ${q || '-'}\n` +
        `CHAT    : ${isGroup ? 'group' : 'private'}\n` +
        `STATUS  : ${logStatus}\n` +
        (errorMsg ? `ERROR   : ${errorMsg}\n` : '') +
        `TIME    : ${execTimeSec}s`
      );
    } catch (_) {}
  }
}

module.exports = {
  handleMessage,
  startProcessing,
  stopProcessing,
  startTyping,
  stopTyping,
  setReaction,
  setProcessingReaction,
  VALID_COMMANDS,
  extractViewOnceMedia,
  getMediaBuffer,
  isDuplicateMessage,
  clearDeduplicationCache
};
