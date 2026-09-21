const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const config = require('../config');

/**
 * Eksekusi command yt-dlp secara promise
 */
function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const ytdlpBin = fs.existsSync(path.join(__dirname, '..', 'yt-dlp.exe'))
      ? path.join(__dirname, '..', 'yt-dlp.exe')
      : config.ytdlp.command;

    const proc = spawn(ytdlpBin, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr || `yt-dlp exited with code ${code}`));
      }
    });

    proc.on('error', reject);
  });
}

/**
 * 1. DOWNLOADER: TikTok via TikWM API dengan fallback
 */
async function getTikTok(url) {
  try {
    const res = await axios.get(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`, {
      timeout: 12000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    });

    if (res.data && res.data.code === 0 && res.data.data) {
      const data = res.data.data;
      return {
        title: data.title || 'TikTok Video',
        author: data.author?.nickname || data.author?.unique_id || 'User',
        videoUrl: data.play || data.wmplay,
        audioUrl: data.music,
        duration: data.duration
      };
    }
    throw new Error('TikWM API tidak mengembalikan video valid.');
  } catch (err) {
    throw err;
  }
}

/**
 * TikTok Stalk Profil
 */
async function stalkTikTok(username) {
  const cleanUser = username.replace(/^@/, '');
  try {
    const res = await axios.get(`https://www.tikwm.com/api/user/info?unique_id=${encodeURIComponent(cleanUser)}`, {
      timeout: 10000
    });
    if (res.data?.data) {
      const u = res.data.data.user;
      const s = res.data.data.stats;
      return {
        nickname: u.nickname,
        username: u.uniqueId,
        avatar: u.avatarLarger || u.avatarMedium,
        bio: u.signature || '-',
        followers: s.followerCount,
        following: s.followingCount,
        hearts: s.heartCount,
        videos: s.videoCount,
        verified: u.verified
      };
    }
    throw new Error('User TikTok tidak ditemukan');
  } catch (err) {
    throw err;
  }
}

/**
 * 2. DOWNLOADER: Mediafire Direct Link
 */
async function getMediafire(url) {
  try {
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      },
      timeout: 15000
    });
    const html = res.data;
    const downloadMatch = html.match(/href="((?:https?:\/\/download\d+\.mediafire\.com\/[^"]+))"/i)
      || html.match(/aria-label="Download file"\s+href="([^"]+)"/i);

    const nameMatch = html.match(/<div class="filename">([^<]+)<\/div>/i)
      || html.match(/<title>([^<]+)<\/title>/i);

    const sizeMatch = html.match(/<li>File size: <span>([^<]+)<\/span><\/li>/i);

    if (downloadMatch && downloadMatch[1]) {
      return {
        downloadUrl: downloadMatch[1],
        filename: nameMatch ? nameMatch[1].trim() : 'mediafire_file',
        size: sizeMatch ? sizeMatch[1].trim() : 'Unknown'
      };
    }
    throw new Error('Tautan download MediaFire tidak ditemukan');
  } catch (err) {
    throw err;
  }
}

/**
 * 3. DOWNLOADER: GitHub Clone ZIP
 */
function getGitClone(url) {
  const regex = /github\.com\/([^\/]+)\/([^\/\?#]+)/i;
  const match = url.match(regex);
  if (!match) throw new Error('Link GitHub tidak valid (contoh: https://github.com/user/repo)');

  const user = match[1];
  const repo = match[2].replace(/\.git$/, '');
  const zipUrl = `https://api.github.com/repos/${user}/${repo}/zipball`;

  return {
    user,
    repo,
    zipUrl,
    filename: `${repo}-main.zip`
  };
}

/**
 * 4. SEARCH: Fast YouTube Search via HTML Scraper (Instan, 1 detik)
 */
async function searchYouTube(query, limit = 5) {
  try {
    const res = await axios.get('https://www.youtube.com/results?search_query=' + encodeURIComponent(query), {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 10000
    });
    const html = res.data;
    const match = html.match(/var ytInitialData = ({.*?});<\/script>/);
    if (match) {
      const data = JSON.parse(match[1]);
      const sections = data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents;
      const items = sections?.[0]?.itemSectionRenderer?.contents || [];
      const results = [];
      for (const it of items) {
        const v = it.videoRenderer;
        if (v && v.videoId) {
          results.push({
            id: v.videoId,
            title: v.title?.runs?.[0]?.text || 'No Title',
            duration: v.lengthText?.simpleText || 'Unknown',
            author: v.ownerText?.runs?.[0]?.text || 'Channel',
            views: v.viewCountText?.simpleText || '0 views',
            url: 'https://www.youtube.com/watch?v=' + v.videoId
          });
        }
      }
      if (results.length > 0) return results.slice(0, limit);
    }
  } catch (_) { }

  // Fallback ke yt-dlp jika web scraping gagal
  try {
    const output = await runYtDlp([
      `ytsearch${limit}:${query}`,
      '--dump-json',
      '--no-playlist',
      '--default-search', 'ytsearch'
    ]);
    const lines = output.split('\n').filter(Boolean);
    const results = [];
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        results.push({
          id: item.id,
          title: item.title,
          url: item.webpage_url || `https://www.youtube.com/watch?v=${item.id}`,
          duration: item.duration_string || `${item.duration}s`,
          author: item.uploader || item.channel || 'Unknown',
          views: item.view_count || 0
        });
      } catch (_) { }
    }
    return results;
  } catch (err) {
    return [];
  }
}

/**
 * Download YouTube Audio (.play)
 */
async function downloadYouTubeAudio(queryOrUrl, outputFile) {
  let target = queryOrUrl;
  let trackTitle = queryOrUrl;

  // Jika bukan link, cari URL langsung dulu via searchYouTube (jauh lebih cepat)
  if (!queryOrUrl.startsWith('http')) {
    const searchRes = await searchYouTube(queryOrUrl, 1);
    if (searchRes.length > 0) {
      target = searchRes[0].url;
      trackTitle = searchRes[0].title;
    } else {
      target = `ytsearch1:${queryOrUrl}`;
    }
  }

  await runYtDlp([
    target,
    '-x',
    '--audio-format', 'mp3',
    '--audio-quality', '192K',
    '-o', outputFile,
    '--no-playlist',
    '--no-check-certificates'
  ]);

  return {
    success: fs.existsSync(outputFile),
    title: trackTitle
  };
}

/**
 * Download YouTube Video (.play2)
 */
async function downloadYouTubeVideo(queryOrUrl, outputFile) {
  let target = queryOrUrl;
  let videoTitle = queryOrUrl;

  if (!queryOrUrl.startsWith('http')) {
    const searchRes = await searchYouTube(queryOrUrl, 1);
    if (searchRes.length > 0) {
      target = searchRes[0].url;
      videoTitle = searchRes[0].title;
    } else {
      target = `ytsearch1:${queryOrUrl}`;
    }
  }

  await runYtDlp([
    target,
    '-f', 'bv*[ext=mp4][height<=720]+ba*[ext=m4a]/b[ext=mp4][height<=720]/best[ext=mp4]/best',
    '--merge-output-format', 'mp4',
    '-o', outputFile,
    '--no-playlist',
    '--no-check-certificates'
  ]);

  return {
    success: fs.existsSync(outputFile),
    title: videoTitle
  };
}

/**
 * 5. SEARCH & DOWNLOAD: Pinterest Search
 */
async function searchPinterest(query) {
  try {
    const res = await axios.get(`https://www.pinterest.com/resource/BaseSearchResource/get/`, {
      params: {
        source_url: `/search/pins/?q=${encodeURIComponent(query)}`,
        data: JSON.stringify({
          options: {
            isPrefetch: false,
            query: query,
            scope: 'pins',
            page_size: 15
          },
          context: {}
        })
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 10000
    });

    const results = [];
    const items = res.data?.resource_response?.data?.results || [];
    for (const it of items) {
      const img = it.images?.orig?.url || it.images?.['736x']?.url;
      if (img) {
        results.push({
          title: it.grid_title || it.title || query,
          image: img,
          pinUrl: `https://www.pinterest.com/pin/${it.id}/`
        });
      }
    }
    if (results.length > 0) return results;
  } catch (_) { }

  // Fallback
  return await searchImages(query + ' pinterest');
}

/**
 * Search Images (DuckDuckGo Image / Pixabay API)
 */
async function searchImages(query) {
  try {
    const tokenRes = await axios.get(`https://duckduckgo.com/?q=${encodeURIComponent(query)}&t=h_&iax=images&ia=images`, {
      timeout: 10000
    });
    const tokenMatch = tokenRes.data.match(/vqd=([\d-]+)&/);
    if (!tokenMatch) throw new Error('No vqd');
    const vqd = tokenMatch[1];

    const searchRes = await axios.get(`https://duckduckgo.com/i.js`, {
      params: {
        l: 'wt-wt',
        o: 'json',
        q: query,
        vqd: vqd,
        f: ',,,',
        p: '1'
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      },
      timeout: 10000
    });

    const list = (searchRes.data?.results || []).map((r) => ({
      title: r.title,
      image: r.image,
      source: r.url
    }));
    return list.slice(0, 10);
  } catch (e) {
    return [
      {
        title: query,
        image: `https://source.unsplash.com/featured/?${encodeURIComponent(query)}`,
        source: 'unsplash'
      }
    ];
  }
}

/**
 * 6. SEARCH: Google Search
 */
async function searchGoogle(query) {
  try {
    const res = await axios.get(`https://html.duckduckgo.com/html/`, {
      params: { q: query },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      },
      timeout: 10000
    });

    const html = res.data;
    const cleanTags = (s) => s.replace(/<[^>]+>/g, '').trim();

    const titleMatches = [...html.matchAll(/<h2 class="result__title">[\s\S]*?<a class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
    const snippetMatches = [...html.matchAll(/<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi)];

    const results = [];
    for (let i = 0; i < Math.min(titleMatches.length, 5); i++) {
      let rawUrl = titleMatches[i][1];
      const uddgMatch = rawUrl.match(/uddg=([^&]+)/);
      const url = uddgMatch ? decodeURIComponent(uddgMatch[1]) : rawUrl;
      const title = cleanTags(titleMatches[i][2]);
      const snippet = snippetMatches[i] ? cleanTags(snippetMatches[i][1]) : '';

      results.push({ title, snippet, url });
    }

    return results;
  } catch (err) {
    return [];
  }
}

/**
 * 7. AI: Chatbot (.ai / .ask) via Pollinations AI / Free LLM
 */
async function askAI(prompt, systemInstruction = 'Kamu adalah SikanBot, asisten AI WhatsApp pintar, ramah, dan serba bisa yang dibuat oleh Rahmat Haikal.') {
  try {
    const res = await axios.post('https://text.pollinations.ai/', {
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: prompt }
      ],
      model: 'openai',
      seed: 42
    }, { timeout: 25000 });

    if (typeof res.data === 'string') return res.data.trim();
    if (res.data?.choices?.[0]?.message?.content) {
      return res.data.choices[0].message.content.trim();
    }
    return String(res.data);
  } catch (err) {
    try {
      const fallbackUrl = `https://text.pollinations.ai/${encodeURIComponent(prompt)}?system=${encodeURIComponent(systemInstruction)}`;
      const getRes = await axios.get(fallbackUrl, { timeout: 20000 });
      return String(getRes.data).trim();
    } catch (e2) {
      throw new Error('Server AI sedang sibuk, silakan coba lagi.');
    }
  }
}

/**
 * AI Image Generator (.imagine)
 */
function getImagineUrl(prompt) {
  const seed = Math.floor(Math.random() * 1000000);
  return `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&seed=${seed}&nologo=true`;
}

/**
 * 8. TOOLS: Translate (.translate / .tr)
 */
async function translateText(text, targetLang = 'id') {
  try {
    const res = await axios.get(`https://translate.googleapis.com/translate_a/single`, {
      params: {
        client: 'gtx',
        sl: 'auto',
        tl: targetLang,
        dt: 't',
        q: text
      },
      timeout: 10000
    });

    if (res.data && res.data[0]) {
      const translated = res.data[0].map((item) => item[0]).join('');
      return translated;
    }
    throw new Error('Gagal menerjemahkan teks');
  } catch (err) {
    throw err;
  }
}

/**
 * 9. TOOLS: Cuaca (.weather / .cuaca)
 */
async function getWeather(city) {
  try {
    const res = await axios.get(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, {
      timeout: 10000
    });
    const current = res.data.current_condition[0];
    const area = res.data.nearest_area[0];

    return {
      location: `${area.areaName[0].value}, ${area.country[0].value}`,
      tempC: current.temp_C,
      feelsLikeC: current.FeelsLikeC,
      condition: current.weatherDesc[0].value,
      humidity: current.humidity,
      windSpeed: current.windspeedKmph,
      uvIndex: current.uvIndex
    };
  } catch (err) {
    throw new Error(`Data cuaca untuk kota "${city}" tidak ditemukan.`);
  }
}

/**
 * 10. TOOLS: Pemendek URL (.shorturl / .short)
 */
async function shortenUrl(longUrl) {
  try {
    const res = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(longUrl)}`, {
      timeout: 10000
    });
    return res.data.trim();
  } catch (err) {
    throw new Error('Gagal memendekkan URL');
  }
}

/**
 * 11. TOOLS: Buat Dokumen PDF (.pdf)
 */
function createPdfFromText(text, title = 'Dokumen SikanBot') {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 40 });
      const buffers = [];

      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => {
        resolve(Buffer.concat(buffers));
      });

      // Header Dokumen
      doc.fontSize(20).font('Helvetica-Bold').text(title, { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(10).font('Helvetica').fillColor('#666666').text(`Dibuat otomatis oleh SikanBot | ${new Date().toLocaleString('id-ID')}`, { align: 'center' });
      doc.moveDown(1);
      doc.strokeColor('#cccccc').lineWidth(1).moveTo(40, doc.y).lineTo(570, doc.y).stroke();
      doc.moveDown(1);

      // Isi Dokumen
      doc.fontSize(12).font('Helvetica').fillColor('#000000').text(text, {
        align: 'justify',
        lineGap: 4
      });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * 12. TOOLS: Buat QR Code (.qrcode / .qr)
 */
async function createQrCode(text) {
  return await QRCode.toBuffer(text, {
    width: 512,
    margin: 2,
    color: {
      dark: '#000000',
      light: '#ffffff'
    }
  });
}

/**
 * 13. TOOLS: Screenshot Web (.ssweb / .ss)
 */
function getWebScreenshotUrl(url) {
  const clean = url.startsWith('http') ? url : `https://${url}`;
  return `https://image.thum.io/get/width/1280/crop/800/noanimate/${clean}`;
}

/**
 * 14. TOOLS: OCR (Optical Character Recognition) dari image buffer
 */
async function getOCR(imageBuffer, lang = 'eng') {
  const base64Data = 'data:image/png;base64,' + imageBuffer.toString('base64');
  const params = new URLSearchParams();
  params.append('apikey', 'K87899148788957');
  params.append('base64Image', base64Data);
  params.append('language', lang);
  params.append('filetype', 'PNG');

  const res = await axios.post('https://api.ocr.space/parse/image', params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 25000
  });

  const parsed = res.data?.ParsedResults?.[0]?.ParsedText?.trim();
  if (!parsed) throw new Error('Tidak ada teks yang dapat dikenali dari gambar ini.');
  return parsed;
}

/**
 * 15. STICKER: Emoji Mix (.emix)
 */
async function getEmojiMix(emoji1, emoji2) {
  return `https://emojik.vercel.app/s/${encodeURIComponent(emoji1)}_${encodeURIComponent(emoji2)}?size=512`;
}

module.exports = {
  axios,
  getTikTok,
  stalkTikTok,
  getMediafire,
  getGitClone,
  searchYouTube,
  downloadYouTubeAudio,
  downloadYouTubeVideo,
  searchPinterest,
  searchImages,
  searchGoogle,
  askAI,
  getImagineUrl,
  translateText,
  getWeather,
  shortenUrl,
  createPdfFromText,
  createQrCode,
  getWebScreenshotUrl,
  getOCR,
  getEmojiMix,
  runYtDlp
};
