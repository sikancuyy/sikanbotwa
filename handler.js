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
const { downloadVideo } = require('./downloader');
const { checkUserLimit, consumeUserLimit, formatUserStatus } = require('./helpers/limit');
const { getValidGroupParticipants, filterActiveMentions, isGroupAdmin, isBotAdmin, formatKickMessage } = require('./helpers/group');
const { generateTTS, convertToVoiceNote, cleanTempAudio } = require('./helpers/tts');
const { generateQuoteChat, generateBratCustom, generateStickerMeme, generateTTP, searchStickerly, searchTenor, getTelegramStickers, getRandomRyo } = require('./helpers/mediaHelper');
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

// Daftar seluruh command valid bot
const VALID_COMMANDS = new Set([
  // Bot Menu Utama & Submenu Kategori
  'menu', 'help', 'start', 'inmenu', 'indownload', 'insearch', 'ingame',
  'insticker', 'intts', 'inuser', 'intools', 'ingroup', 'inadmin', 'inai', 'ininfo', 'inlog',

  // Bot Menu & Info
  'ping', 'alive', 'uptime', 'runtime', 'bot', 'infobot',
  'owner', 'script', 'donate', 'groups', 'blocklist', 'stats',

  // User & Limit & Database
  'limit', 'ceklimit', 'me', 'daftar', 'register',

  // Admin DB & User Management & Logs
  'users', 'userinfo', 'resetlimit', 'setunlimited', 'setlimit',
  'addadmin', 'deladmin', 'listadmin', 'daftaruser', 'deluser',
  'logs', 'loguser', 'logcmd', 'logerror', 'logdownload', 'loggroup',

  // Download
  'play', 'play2', 'yts', 'tiktok', 'tiktokfoto', 'tiktokstalk',
  'ig', 'igstory', 'facebook', 'twitter', 'spotify',
  'mediafire', 'gdrive', 'gitclone', 'pinterest', 'img',

  // Search
  'google',

  // Game & Fun
  'tictactoe', 'delttt', 'math', 'ppt', 'suit', 'slot', 'casino',
  'yourmom', 'teri', 'tebakgambar', 'tebakkata', 'coinflip', 'dadu',

  // Sticker & Media
  'sticker', 'take', 'smaker', 'getsticker', 'emix', 'toimg', 'tovid',
  'attp', 'ttp', 'brat', 'bratcolor', 'brathd', 'bratvid', 'bratvid2',
  'brat2', 'brat3', 'anyabrat', 'animebrat', 'animebrat2', 'qc', 'qc2',
  'smeme', 'emojigif', 'gifsticker', 'stly', 'stickerlysearch',
  'telestick', 'tenor', 'stickersearch', 'ryo',

  // TTS
  'tts',

  // Tools
  'calc', 'qrcode', 'shorturl', 'translate', 'ssweb', 'ocr', 'weather', 'pdf',

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

// In-memory cache untuk group metadata (TTL 5 menit) agar bot tidak freeze / terkena rate limit
const groupCache = new Map();

async function getGroupMetadataSafe(sock, chatId, forceRefresh = false) {
  const cached = groupCache.get(chatId);
  const now = Date.now();
  if (!forceRefresh && cached && (now - cached.time < 5 * 60 * 1000)) {
    return cached.data;
  }
  try {
    const data = await Promise.race([
      sock.groupMetadata(chatId),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Group metadata timeout (12s)')), 12000))
    ]);
    if (data) {
      groupCache.set(chatId, { data, time: now });
    }
    return data;
  } catch (err) {
    console.error(`[WARN] Gagal mengambil groupMetadata (${chatId}):`, err.message);
    return cached?.data || null;
  }
}

/**
 * Handler utama pesan WhatsApp
 */
async function handleMessage(sock, msg, startTime) {
  if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

  const chatId = msg.key.remoteJid;
  msg.chat = chatId;
  let commandHasFailed = false;
  let lastCommandError = null;
  const cmdStartTime = Date.now();
  const isGroup = chatId.endsWith('@g.us');
  const botNumber = (sock.user?.id || '').split(':')[0].replace(/[^0-9]/g, '');
  const rawSender = msg.key.fromMe
    ? (botNumber ? `${botNumber}@s.whatsapp.net` : (isGroup ? (msg.key.participant || msg.participant || chatId) : chatId))
    : (isGroup ? (msg.key.participant || msg.participant || chatId) : chatId);
  const normSender = jidNormalizedUser(rawSender || chatId);
  const senderNumber = normSender.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
  const sender = normSender.includes('@') ? normSender : (senderNumber ? `${senderNumber}@s.whatsapp.net` : rawSender);
  const pushName = msg.pushName || 'Kak';
  const isOwner = Boolean(msg.key.fromMe) || db.isOwner(sender) || (botNumber && senderNumber === botNumber);
  const isPrem = isOwner || db.isPremium(sender);
  const isBanned = isOwner ? false : db.isBanned(sender);

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

  // Objek helper reply dengan auto-mention cerdas dan validasi member grup aktif
  const reply = async (text, options = {}) => {
    if (typeof text === 'string' && (text.trim().startsWith('❌') || text.trim().startsWith('🚫'))) {
      commandHasFailed = true;
      lastCommandError = text.replace(/^[❌🚫]\s*/, '').trim();
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
    try {
      return await sock.sendMessage(chatId, { text, ...opts }, { quoted: msg });
    } catch (_) {
      return await sock.sendMessage(chatId, { text, ...opts });
    }
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
    // Deteksi URL media otomatis (berjalan di private chat dan di grup)
    const urlMatch = body.match(/https?:\/\/[^\s]+/i);
    if (urlMatch) {
      await setPresence('composing');
      try {
        const detectedUrl = urlMatch[0];
        const requestId = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

        // Jika link adalah TikTok, periksa apakah berupa slide foto atau video
        if (/tiktok\.com/i.test(detectedUrl)) {
          try {
            const data = await scraper.getTikTok(detectedUrl);
            if (data.isSlide || (Array.isArray(data.images) && data.images.length > 0)) {
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
              return;
            } else if (data.videoUrl) {
              await sock.sendMessage(chatId, {
                video: { url: data.videoUrl },
                caption: `✨ *TikTok No Watermark*\n\n👤 Author: ${data.author}\n📝 Caption: ${data.title}`
              }, { quoted: msg });
              return;
            }
          } catch (_) {
            // Lanjut ke fallback jika getTikTok gagal
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
              return;
            }
          } catch (_) {
            // Lanjut ke fallback yt-dlp jika getInstagram gagal
          }
        }

        const result = await downloadVideo(detectedUrl, requestId);
        const videoBuffer = fs.readFileSync(result.filePath);
        await sock.sendMessage(chatId, {
          video: videoBuffer,
          caption: `🎥 *${result.title}*\n📦 Ukuran: ${formatBytes(result.fileSize)}`,
          mimetype: 'video/mp4'
        }, { quoted: msg });
        deleteFileSafe(result.filePath);
      } catch (e) {
      } finally {
        await setPresence('paused');
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
    // Bot
    'info': 'infobot',
    'start': 'menu',
    'donasi': 'donate'
  };

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

  // List perintah yang terkena sistem limit pengguna
  const LIMITED_COMMANDS = new Set([
    'play', 'play2', 'tiktok', 'tiktokfoto', 'tiktokstalk', 'ig', 'igstory',
    'facebook', 'twitter', 'spotify', 'mediafire', 'gdrive', 'gitclone', 'img', 'pinterest',
    'sticker', 'take', 'smaker', 'getsticker', 'emix', 'toimg', 'tovid', 'attp', 'ttp',
    'brat', 'bratcolor', 'brathd', 'bratvid', 'bratvid2', 'brat2', 'brat3', 'anyabrat',
    'animebrat', 'animebrat2', 'qc', 'qc2', 'smeme', 'emojigif', 'gifsticker', 'stly',
    'telestick', 'tenor', 'stickersearch', 'ryo',
    'pdf', 'qrcode', 'shorturl', 'translate', 'ssweb', 'ocr', 'weather', 'calc',
    'ai', 'ask', 'imagine', 'summarize', 'tts'
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
    const greeting = isGroup ? `@${senderNumber}` : (pushName || 'Kak');
    const banner = getMainCategoryMenu(greeting);
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
    else if (u?.premium === 1) role = 'Premium';

    const isReg = (u?.registered === 1 || isOwner) ? 'Registered' : 'Not Registered';
    const isPrem = (u?.premium === 1 || isOwner) ? 'Yes' : 'No';
    const isUnlim = (limitCheck.isUnlimited) ? 'Yes' : 'No';
    const limitDisplay = limitCheck.isUnlimited ? 'Unlimited' : limitCheck.remaining;

    const meText = `╭───〔 👤 MY PROFILE 〕
│
├ Nama       : ${u?.name || pushName || 'User'}
├ Nomor      : +${senderNumber}
├ Status     : ${isReg}
├ Role       : ${role}
├ Premium    : ${isPrem}
├ Unlimited  : ${isUnlim}
├ Limit      : ${limitDisplay}
├ Commands   : ${totalCmds.toLocaleString('id-ID')}
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

  if (command === 'daftar' || command === 'register') {
    const existingUser = userDb.getUser(sender);
    if (existingUser && existingUser.registered === 1) {
      return reply('Anda sudah terdaftar sebagai pengguna unlimited.');
    }

    if (q) {
      userDb.registerUser(sender, q);
      commandExecutedSuccessfully = true;
      return reply(
        `Registrasi berhasil.\n\n` +
        `Nama: ${q}\n` +
        `Status: UNLIMITED\n\n` +
        `Sekarang kamu dapat menggunakan fitur bot tanpa batas.`
      );
    }

    registrationSessions.set(sender, true);
    return reply('Silakan balas dengan nama lengkap kamu.');
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
  if (command === 'play') {
    if (!q) return reply(`Masukkan judul lagu atau link YouTube!\nContoh: *${config.prefix}play Denny Caknan Cundamani*`);

    const tempAudio = path.join(config.tempDir, `audio_${Date.now()}.mp3`);
    try {
      const dlRes = await scraper.downloadYouTubeAudio(q, tempAudio);
      if (dlRes.success && fs.existsSync(tempAudio)) {
        const audioBuffer = fs.readFileSync(tempAudio);
        await sock.sendMessage(chatId, {
          audio: audioBuffer,
          mimetype: 'audio/mpeg',
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

  if (command === 'facebook' || command === 'twitter') {
    if (!q) return reply(`Masukkan URL ${command}!\nContoh: *${config.prefix}${command} https://...*`);
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
    const tempAudio = path.join(config.tempDir, `spotify_${Date.now()}.mp3`);
    try {
      const dlRes = await scraper.downloadYouTubeAudio(q, tempAudio);
      if (dlRes.success && fs.existsSync(tempAudio)) {
        const audioBuffer = fs.readFileSync(tempAudio);
        await sock.sendMessage(chatId, {
          audio: audioBuffer,
          mimetype: 'audio/mpeg',
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
    } catch (e) {
      reply(`❌ Gagal mengunduh repo: ${e.message}`);
    }
    return;
  }

  if (command === 'pinterest') {
    if (!q) return reply(`Masukkan kata kunci atau link Pinterest!\nContoh: *${config.prefix}pinterest anime aesthetic*`);
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
  if (['addadmin', 'deladmin', 'listadmin', 'daftaruser', 'deluser', 'users', 'userinfo', 'resetlimit', 'setunlimited', 'setlimit'].includes(command)) {
    const isBotAdminUser = isOwner || userDb.isBotAdmin(sender);

    // addadmin & deladmin khusus Owner
    if (['addadmin', 'deladmin'].includes(command)) {
      if (!isOwner) return reply('❌ Perintah ini khusus untuk *Owner Bot (Rahmat Haikal)*!');
      const target = (args[0] || '').replace(/[^0-9]/g, '');
      if (!target) return reply(`Masukkan nomor yang dituju!\nContoh: *${config.prefix}${command} 62822xxx*`);

      if (command === 'addadmin') {
        userDb.addBotAdmin(target);
        commandExecutedSuccessfully = true;
        return reply(`👑 Berhasil mengangkat +${target} sebagai *Admin Bot*! Sekarang user ini memiliki akses kelola user & bebas limit.`);
      }

      if (command === 'deladmin') {
        userDb.removeBotAdmin(target);
        commandExecutedSuccessfully = true;
        return reply(`✅ Berhasil mencabut hak Admin Bot dari +${target}.`);
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
          text += `${i + 1}. +${a.phone} ${a.name ? `(${a.name})` : ''}\n`;
        });
      }
      commandExecutedSuccessfully = true;
      return reply(text.trim());
    }

    if (command === 'daftaruser') {
      if (!q || !q.includes('|')) {
        return reply(`Format pendaftaran user oleh admin:\n*${config.prefix}daftaruser <nomor>|<nama lengkap>*\nContoh: *${config.prefix}daftaruser 628123456789|Ahmad Fauzi*`);
      }
      const parts = q.split('|').map((s) => s.trim());
      const targetNum = (parts[0] || '').replace(/[^0-9]/g, '');
      const targetName = parts[1] || '';

      if (!targetNum || !targetName) {
        return reply('Nomor dan nama lengkap wajib diisi!');
      }

      userDb.adminRegisterUser(targetNum, targetName);
      commandExecutedSuccessfully = true;
      return reply(
        `✅ *REGISTRASI USER BERHASIL (BY ADMIN)*\n\n` +
        `• Nama   : ${targetName}\n` +
        `• Nomor  : +${targetNum}\n` +
        `• Status : UNLIMITED ♾️\n\n` +
        `User berhasil didaftarkan dan mendapatkan akses tanpa batas.`
      );
    }

    if (command === 'deluser') {
      const target = (args[0] || '').replace(/[^0-9]/g, '');
      if (!target) return reply(`Masukkan nomor pengguna yang ingin dihapus!\nContoh: *${config.prefix}deluser 62822xxx*`);
      const ok = userDb.deleteUser(target);
      if (ok) {
        commandExecutedSuccessfully = true;
        return reply(`🗑️ Data pengguna +${target} berhasil dihapus dari database.`);
      } else {
        return reply('❌ Pengguna tidak ditemukan di database.');
      }
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
          txt += `├ ${num}. ${u.name || 'User'} (+${u.phone}) [${u.limit_type.toUpperCase()}]\n`;
        });
        txt += `╰────────────────\nKetik *${config.prefix}users ${data.page + 1}* untuk halaman berikutnya.`;
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
Gunakan *${config.prefix}users list* untuk melihat daftar pengguna.`;

      commandExecutedSuccessfully = true;
      return reply(summaryText);
    }

    if (command === 'userinfo') {
      const target = (args[0] || '').replace(/[^0-9]/g, '');
      if (!target) return reply(`Masukkan nomor pengguna!\nContoh: *${config.prefix}userinfo 62822xxx*`);
      const info = userDb.getUserInfo(target);
      if (!info) return reply('❌ Pengguna tidak ditemukan di database.');

      const limitCheck = checkUserLimit(info.jid, isOwner, false);
      const isReg = info.registered === 1 ? 'Yes' : 'No';
      const isPrem = info.premium === 1 ? 'Yes' : 'No';
      const isUnlim = (info.limit_type === 'unlimited' || info.unlimited === 1) ? 'Yes' : 'No';
      const limitVal = isUnlim === 'Yes' ? 'Unlimited' : limitCheck.remaining;
      const firstSeen = info.created_at ? new Date(info.created_at).toLocaleDateString('id-ID') : '-';
      const lastSeen = info.updated_at ? new Date(info.updated_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '-';
      const lastCmd = info.last_command ? `.${info.last_command}` : '-';

      const infoText = `╭───〔 👤 USER INFORMATION 〕
│
├ Name       : ${info.name || '-'}
├ Number     : ${info.phone || target}
├ ID         : ${info.id || '-'}
├ Registered : ${isReg}
├ Role       : ${info.is_admin ? 'Admin Bot' : (info.role || 'User')}
├ Premium    : ${isPrem}
├ Unlimited  : ${isUnlim}
├ Limit      : ${limitVal}
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
      const target = (args[0] || '').replace(/[^0-9]/g, '');
      if (!target) return reply(`Masukkan nomor pengguna!\nContoh: *${config.prefix}resetlimit 62822xxx*`);
      const ok = userDb.resetLimit(target);
      if (ok) {
        commandExecutedSuccessfully = true;
        return reply(`✅ Limit penggunaan untuk +${target} berhasil direset menjadi 0.`);
      } else {
        return reply('❌ Pengguna tidak ditemukan atau gagal mereset limit.');
      }
    }

    if (command === 'setunlimited') {
      const target = (args[0] || '').replace(/[^0-9]/g, '');
      if (!target) return reply(`Masukkan nomor pengguna!\nContoh: *${config.prefix}setunlimited 62822xxx*`);
      userDb.setUnlimited(target);
      commandExecutedSuccessfully = true;
      return reply(`✅ Berhasil mengubah status pengguna +${target} menjadi UNLIMITED.`);
    }

    if (command === 'setlimit') {
      const target = (args[0] || '').replace(/[^0-9]/g, '');
      if (!target) return reply(`Masukkan nomor pengguna!\nContoh: *${config.prefix}setlimit 62822xxx*`);
      userDb.setLimit(target);
      commandExecutedSuccessfully = true;
      return reply(`✅ Berhasil mengembalikan status pengguna +${target} menjadi LIMITED (maks 50).`);
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
        txt += `${i + 1}. [${time}] *${l.command}* by +${l.number} [${l.status}]${l.error ? `\n   ⚠️ Error: ${l.error}` : ''}\n`;
      });
      commandExecutedSuccessfully = true;
      return reply(txt.trim());
    }

    if (command === 'loguser') {
      const target = (args[0] || '').replace(/[^0-9]/g, '');
      if (!target) return reply(`Masukkan nomor user!\nContoh: *${config.prefix}loguser 62822xxx*`);
      const logs = userDb.getLogsByUser(target, 15);
      if (!logs || logs.length === 0) return reply(`📋 Tidak ada log untuk user +${target}.`);

      let txt = `👤 *LOG AKTIVITAS USER +${target}*\n\n`;
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
        txt += `${i + 1}. [${time}] +${l.number} [${l.status}] ${l.error ? `(${l.error})` : ''}\n`;
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
        txt += `${i + 1}. [${time}] .${l.command} by +${l.number}\n   ❌ Error: ${l.error || 'Unknown'}\n`;
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
        txt += `${i + 1}. [${time}] .${l.command} ${l.arguments ? `(${l.arguments.slice(0, 30)})` : ''} by +${l.number} [${l.status}]\n`;
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
        txt += `${i + 1}. [${time}] [${l.group_name || 'Grup'}] .${l.command} by +${l.number} [${l.status}]\n`;
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
  VALID_COMMANDS
};
