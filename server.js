const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const MONGODB_URI = process.env.MONGODB_URI || '';

// ---- AUTOPUBLICADOR CONFIG ----
const FB_PROXY = process.env.FB_PROXY || '154.9.130.23:30119:proxyalexis:proxytest';
const GEMINI_PROXY = process.env.GEMINI_PROXY || '154.9.130.23:30119:proxyalexis:proxytest';
const FB_COOKIES = process.env.FB_COOKIES || JSON.stringify([
  {"name":"ps_l","value":"1","domain":".facebook.com","path":"/","secure":true,"httpOnly":true},
  {"name":"datr","value":"2KQUah76zoVpufWfaRyuQCfY","domain":".facebook.com","path":"/","secure":true,"httpOnly":true},
  {"name":"fr","value":"11i4HtPaxTdKEZhBK.AWfrsDQ6vWUEDk6dohgf6b5U1GhMy773E6UoYAAv4-PMyaGMyIM.BqFOOU..AAA.0.0.BqFOOU.AWdcufr-MFEagcCCdMd2_JnGrs4","domain":".facebook.com","path":"/","secure":true,"httpOnly":true},
  {"name":"xs","value":"28%3Avsz3DiUsOxGdOg%3A2%3A1779753871%3A-1%3A-1%3A%3AAcwfMlujh5P-jg0KQbko2FaHLkj_CZbxorIz7sep0A","domain":".facebook.com","path":"/","secure":true,"httpOnly":true},
  {"name":"locale","value":"es_LA","domain":".facebook.com","path":"/","secure":true,"httpOnly":false},
  {"name":"c_user","value":"100092758907474","domain":".facebook.com","path":"/","secure":true,"httpOnly":false},
  {"name":"sb","value":"2KQUaroTQgBF0jG49J0311P9","domain":".facebook.com","path":"/","secure":true,"httpOnly":true},
  {"name":"ps_n","value":"1","domain":".facebook.com","path":"/","secure":true,"httpOnly":true},
  {"name":"presence","value":"C%7B%22t3%22%3A%5B%5D%2C%22utc3%22%3A1779753958294%2C%22v%22%3A1%7D","domain":".facebook.com","path":"/","secure":true,"httpOnly":false}
]);
let GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

// ---- MONGODB ----
let db = null;

async function loadGeminiKey() {
  if (!db) return;
  try {
    const cfg = await db.collection('config').findOne({ key: 'gemini' });
    if (cfg && cfg.geminiKey) {
      GEMINI_API_KEY = cfg.geminiKey;
      console.log('  ✅ Gemini key cargada desde DB');
    }
  } catch(e) { console.log('  ⚠️ No se pudo cargar Gemini key:', e.message); }
}

async function connectDB() {
  if (!MONGODB_URI) { console.log('  ⚠️ Sin MONGODB_URI'); return; }
  try {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db('viralpanel');
    console.log('  ✅ MongoDB conectado');
    // Crear índices
    await db.collection('config').createIndex({ key: 1 }, { unique: true });
    await db.collection('posts').createIndex({ id: 1 }, { unique: true });
    await db.collection('scheduled').createIndex({ scheduledAt: 1 });
  } catch(e) {
    console.error('  ❌ MongoDB error:', e.message);
  }
}

// DB helpers
async function dbGet(collection, query) {
  if (!db) return null;
  return await db.collection(collection).findOne(query);
}
async function dbSet(collection, query, data) {
  if (!db) return;
  await db.collection(collection).updateOne(query, { $set: data }, { upsert: true });
}
async function dbGetAll(collection, query = {}) {
  if (!db) return [];
  return await db.collection(collection).find(query).toArray();
}
async function dbDelete(collection, query) {
  if (!db) return;
  await db.collection(collection).deleteOne(query);
}

function corsHeaders(extra) {
  return Object.assign({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  }, extra || {});
}

function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', d => b += d);
    req.on('end', () => resolve(b));
  });
}

async function getImageBuffer(src) {
  if (src.startsWith('data:')) {
    const mime = src.split(';')[0].replace('data:', '') || 'image/png';
    const base64 = src.split(',')[1];
    return { buffer: Buffer.from(base64, 'base64'), mime };
  }
  return new Promise((resolve, reject) => {
    const doGet = (u) => {
      try {
        const parsed = new url.URL(u);
        const mod = parsed.protocol === 'https:' ? https : require('http');
        mod.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
          if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
            return doGet(res.headers.location);
          }
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => resolve({ buffer: Buffer.concat(chunks), mime: res.headers['content-type'] || 'image/jpeg' }));
          res.on('error', reject);
        }).on('error', reject);
      } catch(e) { reject(e); }
    };
    doGet(src);
  });
}

function buildMultipart(boundary, fields, fileField, fileBuffer, fileName, mimeType) {
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`;
  return Buffer.concat([
    Buffer.from(parts.join('')),
    Buffer.from(fileHeader),
    fileBuffer,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
}

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const options = { hostname, path, method: 'POST', headers };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---- SCHEDULER ----
const scheduledPosts = [];

function addScheduledPost(post) {
  scheduledPosts.push(post);
  if (db) dbSet('scheduled', { postId: post.postId }, post);
  console.log('  📅 Post programado:', new Date(post.scheduledAt).toLocaleString());
}

async function publishScheduledPost(post) {
  try {
    const { buffer: imgBuffer, mime: imgMime } = await getImageBuffer(post.imageSrc);
    const boundary = '----FBSched' + Math.random().toString(36).substr(2);
    const formData = buildMultipart(
      boundary,
      { message: post.caption, access_token: post.token },
      'source', imgBuffer, 'image.jpg', imgMime.split(';')[0]
    );
    const result = await httpsPost(
      'graph.facebook.com', `/${post.pageId}/photos`,
      { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': formData.length },
      formData
    );
    const data = JSON.parse(result.body);
    if (data.id || data.post_id) {
      console.log('  ✅ Post programado publicado!');
      post.status = 'published';
      post.publishedAt = new Date().toISOString();
      if (db) dbSet('scheduled', { postId: post.postId }, post);
    } else {
      post.status = 'error';
      post.error = data.error?.message;
      if (db) dbSet('scheduled', { postId: post.postId }, post);
    }
  } catch (e) {
    post.status = 'error';
    post.error = e.message;
  }
}

setInterval(async () => {
  const now = new Date();
  const pending = scheduledPosts.filter(p => p.status === 'pending' && new Date(p.scheduledAt) <= now);
  for (const post of pending) {
    post.status = 'publishing';
    await publishScheduledPost(post);
  }
}, 30000);

const server = http.createServer(async (req, res) => {
  // Set timeout to 3 minutes for slow AI requests
  req.setTimeout(180000);
  res.setTimeout(180000);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders()); res.end(); return;
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // Servir index.html
  if (pathname === '/' || pathname === '/index.html') {
    const filePath = path.join(__dirname, 'index.html');
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(filePath).pipe(res);
    } else { res.writeHead(404); res.end('index.html no encontrado'); }
    return;
  }

  // ---- GUARDAR CONFIGURACION ----
  if (pathname === '/api/config/save') {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body);
      await dbSet('config', { key: 'main' }, { key: 'main', ...payload, updatedAt: new Date() });
      res.writeHead(200, corsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ success: true }));
    } catch(e) {
      res.writeHead(500, corsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ---- CARGAR CONFIGURACION ----
  if (pathname === '/api/config/load') {
    try {
      const config = await dbGet('config', { key: 'main' });
      res.writeHead(200, corsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify(config || {}));
    } catch(e) {
      res.writeHead(500, corsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ---- GUARDAR POSTS ----
  if (pathname === '/api/posts/save') {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body);
      for (const post of payload.posts || []) {
        await dbSet('posts', { id: post.id }, { ...post, savedAt: new Date() });
      }
      res.writeHead(200, corsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ success: true }));
    } catch(e) {
      res.writeHead(500, corsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ---- CARGAR POSTS ----
  if (pathname === '/api/posts/load') {
    try {
      const posts = await dbGetAll('posts');
      res.writeHead(200, corsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ posts }));
    } catch(e) {
      res.writeHead(500, corsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ posts: [] }));
    }
    return;
  }

  // ---- BORRAR POSTS ----
  if (pathname === '/api/posts/clear') {
    try {
      if (db) await db.collection('posts').deleteMany({});
      res.writeHead(200, corsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ success: true }));
    } catch(e) {
      res.writeHead(500, corsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ---- EDITAR IMAGEN CON gpt-image-1 ----
  if (pathname === '/api/openai/edit-image') {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body);
      const { imageUrl, prompt } = payload;
      if (!imageUrl || !prompt) {
        res.writeHead(400, corsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: 'imageUrl y prompt requeridos' })); return;
      }

      const enhancedPrompt = `${prompt}. Important: maintain the original composition, keep all people and faces exactly as they are, preserve the original image dimensions and aspect ratio, output in the highest quality possible.`;
      const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
      
      // Store job status
      if (!global.aiJobs) global.aiJobs = {};
      global.aiJobs[jobId] = { status: 'processing', result: null, error: null, createdAt: Date.now() };

      // Respond immediately with job ID
      res.writeHead(202, corsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ jobId, status: 'processing' }));

      // Process in background
      (async () => {
        try {
          console.log('  🤖 Iniciando gpt-image-2 en background, job:', jobId);
          const { buffer: imgBuffer, mime: imgMime } = await getImageBuffer(imageUrl);
          const ext = imgMime.includes('png') ? 'png' : 'jpeg';
          const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';
          
          const boundary = '----FormBoundary' + Math.random().toString(36).substr(2);
          const formData = buildMultipart(
            boundary,
            { model: 'gpt-image-2', prompt: enhancedPrompt, size: '1024x1024', quality: 'high' },
            'image[]', imgBuffer, 'image.' + ext, mimeType
          );
          const result = await httpsPost(
            'api.openai.com', '/v1/images/edits',
            {
              'Authorization': 'Bearer ' + OPENAI_API_KEY,
              'Content-Type': `multipart/form-data; boundary=${boundary}`,
              'Content-Length': formData.length
            },
            formData,
            180000
          );
          console.log('  ✅ gpt-image-2 completó job:', jobId, 'status:', result.status);
          const data = JSON.parse(result.body);
          global.aiJobs[jobId] = { status: 'done', result: data, error: null };
          // Cleanup after 10 minutes
          setTimeout(() => { delete global.aiJobs[jobId]; }, 600000);
        } catch(e) {
          console.log('  ❌ gpt-image-2 error job:', jobId, e.message);
          global.aiJobs[jobId] = { status: 'error', result: null, error: e.message };
        }
      })();

    } catch (e) {
      console.log('  ❌ OpenAI error:', e.message);
      res.writeHead(500, corsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ---- POLL JOB STATUS ----
  if (pathname.startsWith('/api/job/')) {
    const jobId = pathname.replace('/api/job/', '');
    const job = global.aiJobs?.[jobId];
    if (!job) {
      res.writeHead(404, corsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: 'Job no encontrado' }));
    } else {
      res.writeHead(200, corsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify(job));
    }
    return;
  }


  // ---- EDITAR IMAGEN CON GEMINI ----
  // ---- TEST GEMINI KEY ----
  if (pathname === '/api/gemini/test') {
    try {
      const body = await readBody(req);
      const { key } = JSON.parse(body);
      if (!key) { res.writeHead(400, corsHeaders({'Content-Type':'application/json'})); res.end(JSON.stringify({error:'Key requerida'})); return; }
      const testPayload = JSON.stringify({
        contents: [{ parts: [{ text: 'Say "OK" in one word' }] }]
      });
      const testResult = await httpsPost(
        'generativelanguage.googleapis.com',
        `/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
        { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(testPayload) },
        Buffer.from(testPayload)
      );
      const testData = JSON.parse(testResult.body);
      if (testData.candidates) {
        res.writeHead(200, corsHeaders({'Content-Type':'application/json'}));
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(200, corsHeaders({'Content-Type':'application/json'}));
        res.end(JSON.stringify({ ok: false, error: testData.error?.message || JSON.stringify(testData) }));
      }
    } catch(e) {
      res.writeHead(500, corsHeaders({'Content-Type':'application/json'}));
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ---- SAVE GEMINI KEY ----
  if (pathname === '/api/config/save-gemini') {
    try {
      const body = await readBody(req);
      const { geminiKey } = JSON.parse(body);
      if (geminiKey) {
        process.env.GEMINI_API_KEY = geminiKey;
        if (db) await dbSet('config', { key: 'gemini' }, { key: 'gemini', geminiKey, updatedAt: new Date() });
      }
      res.writeHead(200, corsHeaders({'Content-Type':'application/json'}));
      res.end(JSON.stringify({ success: true }));
    } catch(e) {
      res.writeHead(500, corsHeaders({'Content-Type':'application/json'}));
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (pathname === '/api/gemini/edit-image') {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body);
      const { imageUrl, prompt } = payload;
      if (!imageUrl || !prompt) {
        res.writeHead(400, corsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: 'imageUrl y prompt requeridos' })); return;
      }

      console.log('  📥 Descargando imagen para Gemini...');
      const { buffer: imgBuffer, mime: imgMime } = await getImageBuffer(imageUrl);
      const base64Image = imgBuffer.toString('base64');
      const mimeType = imgMime.split(';')[0] || 'image/jpeg';

      console.log('  🔮 Enviando a Gemini...');

      // Send prompt exactly as user typed it - no modifications
      const simplePrompt = prompt.trim();
      console.log('  📝 Prompt:', simplePrompt.substring(0, 150));

      const geminiPayload = JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { inline_data: { mime_type: mimeType, data: base64Image } },
            { text: simplePrompt }
          ]
        }],
        generationConfig: {
          responseModalities: ['IMAGE', 'TEXT'],
          temperature: 1.0,
          maxOutputTokens: 2048
        },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' }
        ],
        tools: [],
        toolConfig: { functionCallingConfig: { mode: 'NONE' } }
      });

      console.log('  📤 Enviando a Gemini...');
      const geminiResult = await httpsPost(
        'generativelanguage.googleapis.com',
        '/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=' + encodeURIComponent(GEMINI_API_KEY),
        { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(geminiPayload) },
        Buffer.from(geminiPayload)
      );

console.log('  ✅ Gemini respondió:', geminiResult.status);
      const geminiDebug = JSON.parse(geminiResult.body);
      const finishReason = geminiDebug.candidates?.[0]?.finishReason;
      const hasImage = geminiDebug.candidates?.[0]?.content?.parts?.some(p => p.inlineData || p.inline_data);
      console.log('  🖼️ Imagen:', hasImage ? 'SÍ' : 'NO', '| finishReason:', finishReason);
      if (!hasImage) console.log('  ⚠️ Respuesta completa:', JSON.stringify(geminiDebug).substring(0, 600));
      const geminiData = geminiDebug; // already parsed above

      if (geminiResult.status !== 200) {
        console.log('  ❌ Gemini error:', geminiResult.body);
        res.writeHead(500, corsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: geminiData.error?.message || 'Error de Gemini: ' + geminiResult.status }));
        return;
      }

      let imageBase64 = null;
      if (geminiData.candidates && geminiData.candidates[0]) {
        const parts = geminiData.candidates[0].content?.parts || [];
        for (const part of parts) {
          if (part.inlineData?.mimeType?.startsWith('image/')) {
            imageBase64 = part.inlineData.data;
            break;
          }
          if (part.inline_data?.mime_type?.startsWith('image/')) {
            imageBase64 = part.inline_data.data;
            break;
          }
        }
      }

      if (imageBase64) {
        res.writeHead(200, corsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ data: [{ b64_json: imageBase64 }] }));
      } else {
        res.writeHead(500, corsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: 'Gemini no generó imagen. Intenta con un prompt más simple.' }));
      }

    } catch (e) {
      console.log('  ❌ Error Gemini:', e.message);
      res.writeHead(500, corsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ---- PUBLICAR EN FACEBOOK ----
  if (pathname === '/api/publish-facebook') {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body);
      const { pageId, token, caption, imageSrc } = payload;
      if (!pageId || !token || !caption) {
        res.writeHead(400, corsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: 'pageId, token y caption requeridos' })); return;
      }
      let fbResult;
      if (imageSrc) {
        const { buffer: rawBuffer } = await getImageBuffer(imageSrc);
        // Optimize image for Facebook: resize to 1080x1080, high quality JPEG
        let imgBuffer = rawBuffer;
        try {
          const sharp = require('sharp');
          imgBuffer = await sharp(rawBuffer)
            .resize(1080, 1080, { fit: 'inside', withoutEnlargement: false })
            .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
            .toBuffer();
          console.log('  ✅ Imagen optimizada para Facebook:', imgBuffer.length, 'bytes');
        } catch(e) {
          console.log('  ⚠️ Sharp no disponible, usando imagen original');
        }
        const boundary = '----FBBoundary' + Math.random().toString(36).substr(2);
        const formData = buildMultipart(
          boundary,
          {
            message: caption,
            access_token: token,
            no_story: 'false'
          },
          'source', imgBuffer, 'image.jpg', 'image/jpeg'
        );
        fbResult = await httpsPost(
          'graph.facebook.com', `/${pageId}/photos`,
          {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': formData.length
          },
          formData
        );
      } else {
        const textPayload = JSON.stringify({ message: caption, access_token: token });
        fbResult = await httpsPost(
          'graph.facebook.com', `/${pageId}/feed`,
          { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(textPayload) },
          Buffer.from(textPayload)
        );
      }
      res.writeHead(fbResult.status, corsHeaders({ 'Content-Type': 'application/json' }));
      res.end(fbResult.body);
    } catch (e) {
      res.writeHead(500, corsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ---- PUBLICAR VIA NAVEGADOR (PUPPETEER) ----
  if (pathname === '/api/publish-browser') {
    try {
      const body = await readBody(req);
      const { pageId, pageName, caption, imageSrc } = JSON.parse(body);

      console.log('  🌐 Iniciando autopublicador...');

      let puppeteer;
      try { puppeteer = require('puppeteer-core'); }
      catch(e) { puppeteer = require('puppeteer'); }

      // Parse proxy
      const [proxyHost, proxyPort, proxyUser, proxyPass] = FB_PROXY.split(':');
      const cookies = JSON.parse(FB_COOKIES);

      // Download image and save temp
      const { buffer: imgBuf } = await getImageBuffer(imageSrc);
      const tmpImg = '/tmp/fb_post_' + Date.now() + '.jpg';
      const fsSync = require('fs');
      fsSync.writeFileSync(tmpImg, imgBuf);

      // Find Chrome executable
      const { execSync } = require('child_process');
      let chromePath = process.env.PUPPETEER_EXECUTABLE_PATH || '';
      if (!chromePath) {
        const paths = [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          '/usr/bin/google-chrome',
          '/usr/bin/chromium-browser',
          '/usr/bin/chromium'
        ];
        for (const p of paths) {
          try {
            require('fs').accessSync(p);
            chromePath = p;
            break;
          } catch(e) {}
        }
      }
      // Use puppeteer's bundled chrome if no system chrome found
      const launchOptions = {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          `--proxy-server=http://${proxyHost}:${proxyPort}`
        ]
      };
      if (chromePath) launchOptions.executablePath = chromePath;

      console.log('  🌐 Chrome path:', chromePath || 'bundled');
      const browser = await puppeteer.launch(launchOptions);

      const page = await browser.newPage();

      // Authenticate proxy
      await page.authenticate({ username: proxyUser, password: proxyPass });

      // Set cookies
      await page.setCookie(...cookies);

      // Set realistic user agent
      await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
      await page.setViewport({ width: 390, height: 844 });

      // PASO 1: Ir a Facebook mobile
      console.log('  📱 Paso 1: Abriendo Facebook...');
      await page.goto('https://m.facebook.com/', { waitUntil: 'networkidle2', timeout: 30000 });
      await sleep(2000);

      // Cerrar popup "Facebook es mejor en la app" si aparece
      await page.evaluate(() => {
        const btns = [...document.querySelectorAll('a, button, div[role="button"]')];
        for (const btn of btns) {
          if (btn.textContent.trim() === 'Ahora no' || btn.textContent.trim() === 'Not Now') {
            btn.click(); return;
          }
        }
      }).catch(() => {});
      await sleep(1000);

      // PASO 2: Clic en las 3 rayitas (menú) - arriba derecha
      console.log('  📱 Paso 2: Abriendo menú...');
      await page.screenshot({ path: '/tmp/fb_debug.png' });
      
      const menuClicked = await page.evaluate(() => {
        // Look for menu button (3 lines / hamburger)
        const selectors = ['[aria-label="Menu"]', '[aria-label="Menú"]', 'a[href="/menu/"]'];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el) { el.click(); return true; }
        }
        // Try by icon position (top right area)
        const allLinks = [...document.querySelectorAll('a, [role="button"]')];
        for (const el of allLinks) {
          const rect = el.getBoundingClientRect();
          if (rect.top < 80 && rect.right > 350) { el.click(); return true; }
        }
        return false;
      });
      console.log('  Menú clickeado:', menuClicked);
      await sleep(2000);

      // PASO 3: Clic en la flechita "V" al lado del nombre/foto de perfil
      console.log('  📱 Paso 3: Buscando flechita V junto al perfil...');
      await page.screenshot({ path: '/tmp/fb_step3.png' });
      
      const arrowClicked = await page.evaluate(() => {
        // The arrow "V" (chevron down) is next to the profile name in the menu header
        // It's usually the last clickable element in the profile header row
        const allEls = [...document.querySelectorAll('[role="button"], button, a')];
        
        // Log all elements for debugging
        const topEls = allEls.filter(el => {
          const rect = el.getBoundingClientRect();
          return rect.top > 50 && rect.top < 200 && rect.width > 0;
        });
        console.log('Elements in header area:', topEls.map(el => el.tagName + '|' + (el.getAttribute('aria-label')||'') + '|' + JSON.stringify(el.getBoundingClientRect())).join(' /// '));

        // Try to find chevron by aria-label
        const chevronLabels = ['Expandir', 'Expand', 'Ver más', 'dropdown', 'chevron', 'arrow'];
        for (const el of allEls) {
          const label = (el.getAttribute('aria-label') || '').toLowerCase();
          if (chevronLabels.some(l => label.includes(l))) {
            el.click(); return 'aria-label:' + label;
          }
        }

        // The chevron is typically the rightmost small button in the top section
        // Filter elements in the menu header row (below menu title, above menu items)
        const headerBtns = allEls.filter(el => {
          const rect = el.getBoundingClientRect();
          return rect.top > 60 && rect.top < 160 && rect.right > 300 && rect.width < 60 && rect.height < 60;
        });
        
        if (headerBtns.length > 0) {
          // Click the rightmost one (that's the chevron)
          const rightmost = headerBtns.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0];
          rightmost.click();
          return 'rightmost:' + rightmost.getBoundingClientRect().right;
        }

        return false;
      });
      console.log('  Flechita clickeada:', arrowClicked);
      await sleep(2000);

      // PASO 4: Seleccionar "Miltoner" del popup "Tus páginas y perfiles"
      console.log('  📱 Paso 4: Esperando popup y seleccionando Miltoner...');
      await sleep(2000);
      await page.screenshot({ path: '/tmp/fb_step4.png' });

      const miltonerClicked = await page.evaluate(() => {
        // The popup shows a list: profile name, then pages
        // We need to find exactly "Miltoner" text and click its container
        
        // Get all elements and find the one with ONLY "Miltoner" text
        const allEls = [...document.querySelectorAll('*')];
        
        for (const el of allEls) {
          // Must contain exactly Miltoner and be clickable
          const text = el.textContent.trim();
          const directText = [...el.childNodes]
            .filter(n => n.nodeType === 3)
            .map(n => n.textContent.trim())
            .join('');
          
          if ((text === 'Miltoner' || directText === 'Miltoner') && 
              (el.tagName === 'A' || el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.tagName === 'DIV')) {
            el.click();
            return 'exact:' + el.tagName + ':' + text;
          }
        }

        // Fallback: find by role=radio or similar in the popup
        const radios = [...document.querySelectorAll('[role="radio"], [role="option"], li, [role="listitem"]')];
        for (const el of radios) {
          if (el.textContent.includes('Miltoner') && !el.textContent.includes('McAlexiz')) {
            el.click();
            return 'radio:' + el.textContent.trim().substring(0, 30);
          }
        }

        // Last resort: find all elements with Miltoner text, pick shortest
        const withMiltoner = allEls.filter(el => 
          el.textContent.trim() === 'Miltoner' || 
          (el.textContent.includes('Miltoner') && el.textContent.length < 20)
        );
        
        if (withMiltoner.length > 0) {
          // Sort by text length, click shortest match
          withMiltoner.sort((a, b) => a.textContent.length - b.textContent.length);
          withMiltoner[0].click();
          return 'shortest:' + withMiltoner[0].textContent.trim();
        }

        return false;
      });
      console.log('  Miltoner clickeado:', miltonerClicked);
      await sleep(3000);

      // Cerrar popup si aparece de nuevo
      await page.evaluate(() => {
        const btns = [...document.querySelectorAll('a, button, div[role="button"]')];
        for (const btn of btns) {
          if (btn.textContent.trim() === 'Ahora no' || btn.textContent.trim() === 'Not Now') {
            btn.click(); return;
          }
        }
      }).catch(() => {});
      await sleep(1000);

      // PASO 5: Clic en "Publica una actualización de estado"
      console.log('  📱 Paso 5: Abriendo compositor...');
      const composerClicked = await page.evaluate(() => {
        const allEls = [...document.querySelectorAll('a, [role="button"], input, textarea, div[contenteditable]')];
        for (const el of allEls) {
          const text = el.textContent.trim() || el.placeholder || el.getAttribute('placeholder') || '';
          if (text.includes('actualización') || text.includes('pensando') || text.includes('estado') || text.includes('status')) {
            el.click(); return true;
          }
        }
        return false;
      });
      console.log('  Compositor clickeado:', composerClicked);
      await sleep(2000);
      await page.screenshot({ path: '/tmp/fb_debug.png' });

      // Try to find the post input
      // Try to find the post input
      const postSelectors = [
        '[data-testid="status-attachment-mentions-input"]',
        'textarea[name="xhpc_message"]',
        '[aria-label="Crear publicación"]',
        '[placeholder*="mente"]',
        '[placeholder*="mind"]',
        'textarea'
      ];

      let clicked = false;
      for (const sel of postSelectors) {
        try {
          await page.waitForSelector(sel, { timeout: 3000 });
          await page.click(sel);
          clicked = true;
          console.log('  ✅ Campo de texto encontrado:', sel);
          break;
        } catch(e) {}
      }

      if (!clicked) {
        // Try clicking on photo/video button directly
        await page.evaluate(() => {
          const btns = document.querySelectorAll('[role="button"]');
          for (const btn of btns) {
            if (btn.textContent.includes('Foto') || btn.textContent.includes('Photo')) {
              btn.click(); break;
            }
          }
        });
      }

      await sleep(1500);

      // Upload image
      const fileInput = await page.$('input[type="file"]') || await page.$('[accept*="image"]');
      if (fileInput) {
        await fileInput.uploadFile(tmpImg);
        console.log('  ✅ Imagen subida');
        await sleep(3000);
      }

      // Type caption
      const textArea = await page.$('textarea') || await page.$('[contenteditable="true"]');
      if (textArea) {
        await textArea.click();
        await page.keyboard.type(caption, { delay: 50 });
        console.log('  ✅ Caption escrito');
      }

      await sleep(1500);

      // Wait for image to process
      await sleep(4000);

      // Take screenshot for debugging
      await page.screenshot({ path: '/tmp/fb_debug.png' });
      console.log('  📸 Screenshot guardado en /tmp/fb_debug.png');

      // Esperar que cargue el compositor con imagen
      await sleep(3000);
      await page.screenshot({ path: '/tmp/fb_debug.png' });

      // Clic en botón azul PUBLICAR
      console.log('  📱 Buscando botón PUBLICAR...');
      let published = false;

      // Buscar por texto exacto "PUBLICAR" o "Publicar"
      published = await page.evaluate(() => {
        const texts = ['PUBLICAR', 'Publicar', 'POST', 'Post', 'Share', 'Compartir'];
        
        // Buscar en todos los elementos clickeables
        const allEls = [...document.querySelectorAll('button, a, [role="button"]')];
        
        for (const text of texts) {
          for (const el of allEls) {
            if (el.textContent.trim() === text) {
              // Verificar que no esté deshabilitado
              if (!el.disabled && !el.getAttribute('disabled') && 
                  el.getAttribute('aria-disabled') !== 'true') {
                el.click();
                return 'text:' + text;
              }
            }
          }
        }

        // Buscar botón azul (color de fondo azul de Facebook)
        for (const el of allEls) {
          const style = window.getComputedStyle(el);
          const bg = style.backgroundColor;
          const text = el.textContent.trim();
          // Facebook blue is rgb(24, 119, 242) or similar
          if ((bg.includes('24, 119') || bg.includes('0, 132') || bg.includes('66, 103')) 
              && text.length < 15 && text.length > 1) {
            el.click();
            return 'blue-btn:' + text;
          }
        }

        return false;
      });

      console.log('  Publicar clickeado:', published);
      
      if (!published) {
        // Último intento - buscar por posición (botón abajo de la pantalla)
        published = await page.evaluate(() => {
          const allEls = [...document.querySelectorAll('button, [role="button"]')];
          const bottomBtns = allEls.filter(el => {
            const rect = el.getBoundingClientRect();
            return rect.bottom > 700 && rect.width > 200 && rect.height > 40;
          });
          if (bottomBtns.length > 0) {
            bottomBtns[0].click();
            return 'bottom-btn:' + bottomBtns[0].textContent.trim();
          }
          return false;
        });
        if (published) console.log('  ✅ Publicado via bottom button:', published);
      }

      await sleep(3000);
      await browser.close();
      fsSync.unlinkSync(tmpImg);

      if (published) {
        res.writeHead(200, corsHeaders({'Content-Type':'application/json'}));
        res.end(JSON.stringify({ success: true, method: 'browser' }));
      } else {
        res.writeHead(500, corsHeaders({'Content-Type':'application/json'}));
        res.end(JSON.stringify({ error: 'No se encontró el botón de publicar' }));
      }

    } catch(e) {
      console.log('  ❌ Error autopublicador:', e.message);
      res.writeHead(500, corsHeaders({'Content-Type':'application/json'}));
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ---- PUBLICAR VIA BUSINESS.FACEBOOK.COM ----
  if (pathname === '/api/publish-business') {
    try {
      const body = await readBody(req);
      const { caption, imageSrc } = JSON.parse(body);

      console.log('  🏢 Iniciando autopublicador Business...');

      let puppeteer;
      try { puppeteer = require('puppeteer-core'); }
      catch(e) { puppeteer = require('puppeteer'); }

      const [proxyHost, proxyPort, proxyUser, proxyPass] = FB_PROXY.split(':');
      const cookies = JSON.parse(FB_COOKIES);

      // Save image temp
      const { buffer: imgBuf } = await getImageBuffer(imageSrc);
      const tmpImg = '/tmp/fb_business_' + Date.now() + '.jpg';
      require('fs').writeFileSync(tmpImg, imgBuf);

      const browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          `--proxy-server=http://${proxyHost}:${proxyPort}`
        ],
        executablePath: (() => {
          const os = require('os');
          if(os.platform() === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
          if(os.platform() === 'win32') return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
          return '/usr/bin/chromium-browser';
        })()
      });

      const page = await browser.newPage();
      await page.authenticate({ username: proxyUser, password: proxyPass });
      await page.setCookie(...cookies);
      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      await page.setViewport({ width: 1280, height: 900 });


      // PASO 1: Ir a business.facebook.com
      console.log('  🏢 Paso 1: Abriendo Business Facebook...');
      await page.goto('https://business.facebook.com/', { waitUntil: 'networkidle2', timeout: 30000 });
      await sleep(3000);
      await page.screenshot({ path: '/tmp/fb_biz1.png' });
      console.log('  📍 URL:', page.url());

      // PASO 2: Clic en "Crear publicación"
      console.log('  🏢 Paso 2: Buscando botón Crear publicación...');
      let step2 = false;
      step2 = await page.evaluate(() => {
        const texts = ['Crear publicación', 'Create post', 'Crear post', 'New post'];
        const allEls = [...document.querySelectorAll('button, a, [role="button"], div')];
        for (const text of texts) {
          for (const el of allEls) {
            if (el.textContent.trim() === text || el.textContent.trim().includes(text)) {
              el.click();
              return 'clicked: ' + text;
            }
          }
        }
        return false;
      });
      console.log('  Crear publicación:', step2);
      await sleep(3000);
      await page.screenshot({ path: '/tmp/fb_biz2.png' });

      // PASO 3: Agregar foto
      console.log('  🏢 Paso 3: Subiendo imagen...');
      let imgUploaded = false;
      try {
        // Look for file input
        const fileInputs = await page.$$('input[type="file"]');
        if (fileInputs.length > 0) {
          await fileInputs[0].uploadFile(tmpImg);
          imgUploaded = true;
          console.log('  ✅ Imagen subida');
        } else {
          // Click "Agregar foto" button
          await page.evaluate(() => {
            const texts = ['Agregar foto', 'Add photo', 'Foto', 'Photo', 'Contenido multimedia'];
            const allEls = [...document.querySelectorAll('button, a, [role="button"], div, label')];
            for (const text of texts) {
              for (const el of allEls) {
                if (el.textContent.trim().includes(text)) {
                  el.click(); return text;
                }
              }
            }
          });
          await sleep(1000);
          const fileInputs2 = await page.$$('input[type="file"]');
          if (fileInputs2.length > 0) {
            await fileInputs2[0].uploadFile(tmpImg);
            imgUploaded = true;
            console.log('  ✅ Imagen subida (2do intento)');
          }
        }
      } catch(e) {
        console.log('  ⚠️ Error subiendo imagen:', e.message);
      }
      await sleep(2000);

      // PASO 4: Escribir texto/caption
      console.log('  🏢 Paso 4: Escribiendo caption...');
      let textWritten = false;
      try {
        // Find text area for caption
        const textSelectors = [
          'textarea[placeholder*="texto"]',
          'textarea[placeholder*="text"]',
          'div[contenteditable="true"]',
          '[aria-label*="texto"]',
          '[aria-label*="caption"]',
          '[placeholder*="escribe"]',
          'textarea'
        ];
        for (const sel of textSelectors) {
          try {
            const el = await page.$(sel);
            if (el) {
              await el.click();
              await el.type(caption, { delay: 30 });
              textWritten = true;
              console.log('  ✅ Caption escrito con selector:', sel);
              break;
            }
          } catch(e) {}
        }
      } catch(e) {
        console.log('  ⚠️ Error escribiendo caption:', e.message);
      }
      await sleep(2000);
      await page.screenshot({ path: '/tmp/fb_biz3.png' });

      // PASO 5: Clic en PUBLICAR
      console.log('  🏢 Paso 5: Publicando...');
      let published = false;
      published = await page.evaluate(() => {
        const texts = ['Publicar', 'Publish', 'Post', 'PUBLICAR'];
        const allEls = [...document.querySelectorAll('button, [role="button"]')];
        for (const text of texts) {
          for (const el of allEls) {
            if (el.textContent.trim() === text && !el.disabled) {
              el.click();
              return 'published:' + text;
            }
          }
        }
        // Try blue button at bottom
        const bottomBtns = allEls.filter(el => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.bottom > 600 && rect.width > 100 && 
                 (style.backgroundColor.includes('24, 119') || style.backgroundColor.includes('0, 132'));
        });
        if (bottomBtns.length > 0) {
          bottomBtns[0].click();
          return 'blue-btn: ' + bottomBtns[0].textContent.trim();
        }
        return false;
      });
      console.log('  Publicar:', published);
      await sleep(3000);

      await browser.close();
      require('fs').unlinkSync(tmpImg);

      if (published) {
        res.writeHead(200, corsHeaders({'Content-Type':'application/json'}));
        res.end(JSON.stringify({ success: true, method: 'business' }));
      } else {
        res.writeHead(500, corsHeaders({'Content-Type':'application/json'}));
        res.end(JSON.stringify({ error: 'No se pudo publicar via Business' }));
      }

    } catch(e) {
      console.log('  ❌ Error Business:', e.message);
      res.writeHead(500, corsHeaders({'Content-Type':'application/json'}));
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ---- EDITAR IMAGEN VIA GEMINI WEB (MOBILE) ----
  if (pathname === '/api/gemini/edit-web') {
    try {
      const body = await readBody(req);
      const { imageUrl, prompt } = JSON.parse(body);

      console.log('  🌐 Iniciando Gemini Mobile...');

      let puppeteer;
      try { puppeteer = require('puppeteer-core'); }
      catch(e) { puppeteer = require('puppeteer'); }

      // Save image temp
      const { buffer: imgBuf } = await getImageBuffer(imageUrl);
      const tmpImg = '/tmp/gemini_input_' + Date.now() + '.jpg';
      require('fs').writeFileSync(tmpImg, imgBuf);

      const os = require('os');
      const fs = require('fs');

      // Copy Profile 2 cookies to temp dir
      const srcProfile = os.homedir() + '/Library/Application Support/Google/Chrome/Profile 2';
      const tmpProfile = '/tmp/gemini_profile_' + Date.now();
      fs.mkdirSync(tmpProfile, { recursive: true });
      fs.mkdirSync(tmpProfile + '/Default', { recursive: true });

      // Copy cookies
      for (const file of ['Cookies', 'Cookies-journal', 'Login Data', 'Web Data']) {
        const src = srcProfile + '/' + file;
        if (fs.existsSync(src)) {
          try { fs.copyFileSync(src, tmpProfile + '/Default/' + file); } catch(e) {}
        }
      }
      console.log('  📂 Perfil copiado desde Profile 2');

      const browser = await puppeteer.launch({
        headless: false,
        userDataDir: tmpProfile,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled',
          '--profile-directory=Default'
        ],
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      });

      const page = await browser.newPage();

      // Mobile iPhone viewport
      await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
      await page.setViewport({ width: 390, height: 844, isMobile: true });

      // Load Google cookies
      // cookies already loaded below
      const cookiesList = [
        {"name":"SAPISID","value":"IjsJyDXJg0NkCut0/A9rYXXmSYfD-CN3NX","domain":".google.com","path":"/","secure":true,"httpOnly":false},
        {"name":"__Secure-3PAPISID","value":"IjsJyDXJg0NkCut0/A9rYXXmSYfD-CN3NX","domain":".google.com","path":"/","secure":true,"httpOnly":false},
        {"name":"__Secure-1PSID","value":"g.a000-QjE_RbxoFyVSEGeTgiBQNzxZLaCpsI3ORSjgQunI9oUHI-nIAgxlXIvKXe3BzgyypKfOQACgYKAdoSARUSFQHGX2Mi3lK-KoMWE42nSD_nT-nJExoVAUF8yKrONbkpFdrsP5yuwzEtYlIb0076","domain":".google.com","path":"/","secure":true,"httpOnly":true},
        {"name":"__Secure-3PSID","value":"g.a000-QjE_RbxoFyVSEGeTgiBQNzxZLaCpsI3ORSjgQunI9oUHI-nhq458UYpdlc9i4b8pSYEygACgYKAZQSARUSFQHGX2Mir_SL-MwooG8QkBWN7vdq9hoVAUF8yKpiFUTSQPuA2GEljDyJiCBt0076","domain":".google.com","path":"/","secure":true,"httpOnly":true},
        {"name":"SSID","value":"A_mUXVbBAF-VSCR3S","domain":".google.com","path":"/","secure":true,"httpOnly":true},
        {"name":"__Secure-1PSIDTS","value":"sidts-CjEBhkeRd8cY4ggwIlxpUCl-BvC1gXFqeOUNaXtPsNYXEpLz-vALFfSNOCk-dTrQgYZFEAA","domain":".google.com","path":"/","secure":true,"httpOnly":true},
        {"name":"COMPASS","value":"gemini-pd=CjwACWuJV93jFYb_b6k1ZbZc5AVi75OXfwVJx6huPFdJgLZgT-iphNSBtyIyTho-2Gurv4U86El7hPmdVFUQiOTZ0AYaZgAJa4lXuxnsGsQqgGi_Aw1Vh_Wb02GKM0FCkS0zzqIEmtd9S3-zmP3ETEZAhsQ3zt2fUz3SFVOTU7OtkNgFE1_4yno9o_k9X6GD6yG2I6BxMkkn1C84uznWpTz4uNP4yr_pMSqqmyABMAE","domain":".gemini.google.com","path":"/","secure":true,"httpOnly":true}
      ];
      await page.setCookie(...cookiesList);

      // PASO 1: Abrir Gemini mobile
      console.log('  📱 Paso 1: Abriendo Gemini mobile...');
      await page.goto('https://gemini.google.com/', { waitUntil: 'networkidle2', timeout: 30000 });
      await sleep(3000);
      console.log('  📍 URL:', page.url());
      await page.screenshot({ path: '/tmp/gemini_p1.png' });

      // PASO 2: Click en + (adjuntar)
      console.log('  📱 Paso 2: Buscando botón +...');
      
      // Try to find file input directly first
      let fileInput = await page.$('input[type="file"]');
      
      if (!fileInput) {
        // Click + button or attachment button
        const plusClicked = await page.evaluate(() => {
          const allBtns = [...document.querySelectorAll('button, [role="button"], a')];
          console.log('All buttons:', allBtns.map(b => b.getAttribute('aria-label')+'|'+b.textContent.trim().substring(0,20)).join(' // '));
          
          for (const btn of allBtns) {
            const label = (btn.getAttribute('aria-label') || '').toLowerCase();
            const text = btn.textContent.trim();
            if (label.includes('add') || label.includes('attach') || label.includes('image') || 
                label.includes('imagen') || label.includes('archivo') || label.includes('file') ||
                text === '+' || label === '+') {
              btn.click();
              return label || text;
            }
          }
          return false;
        });
        console.log('  + clicked:', plusClicked);
        await sleep(1500);
        await page.screenshot({ path: '/tmp/gemini_p2.png' });
        fileInput = await page.$('input[type="file"]');
      }

      // PASO 3: Si aparece menú, click en "Archivos" o "Fotos"
      if (!fileInput) {
        const menuClicked = await page.evaluate(() => {
          const allEls = [...document.querySelectorAll('*')];
          const keywords = ['Archivos', 'Files', 'Fotos', 'Photos', 'Galería', 'Gallery', 'Upload', 'Subir'];
          for (const el of allEls) {
            if (keywords.some(k => el.textContent.trim() === k || el.getAttribute('aria-label') === k)) {
              el.click();
              return el.textContent.trim();
            }
          }
          return false;
        });
        console.log('  Menu item clicked:', menuClicked);
        await sleep(1500);
        fileInput = await page.$('input[type="file"]');
      }

      // PASO 4: Subir archivo
      if (fileInput) {
        console.log('  ✅ Input file encontrado, subiendo imagen...');
        await fileInput.uploadFile(tmpImg);
        await sleep(3000);
        await page.screenshot({ path: '/tmp/gemini_p3.png' });
        console.log('  ✅ Imagen subida');
      } else {
        console.log('  ⚠️ No se encontró input file');
        await page.screenshot({ path: '/tmp/gemini_p2_noinput.png' });
      }

      // PASO 5: Escribir prompt
      console.log('  📱 Paso 5: Escribiendo prompt...');
      const textArea = await page.$('div[contenteditable="true"]') || 
                       await page.$('textarea') ||
                       await page.$('[role="textbox"]');
      if (textArea) {
        await textArea.click();
        await sleep(300);
        await page.keyboard.type(prompt, { delay: 20 });
        console.log('  ✅ Prompt escrito');
      }
      await sleep(1000);

      // PASO 6: Click en botón enviar (flechita)
      console.log('  📱 Paso 6: Buscando botón enviar...');
      await sleep(1000);
      
      const sendClicked = await page.evaluate(() => {
        // Look for send/submit button - usually an arrow icon
        const allBtns = [...document.querySelectorAll('button, [role="button"]')];
        console.log('Send buttons:', allBtns.map(b => b.getAttribute('aria-label')+'|'+b.getAttribute('data-testid')).join(' // '));
        
        const sendLabels = ['Send message', 'Enviar mensaje', 'Send', 'Enviar', 'Submit', 'Go', 'send_spark'];
        for (const btn of allBtns) {
          const label = (btn.getAttribute('aria-label') || '').toLowerCase();
          const testid = (btn.getAttribute('data-testid') || '').toLowerCase();
          if (sendLabels.some(l => label.includes(l.toLowerCase()) || testid.includes(l.toLowerCase()))) {
            // Make sure it's not disabled
            if (!btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
              btn.click();
              return 'clicked: ' + (btn.getAttribute('aria-label') || btn.getAttribute('data-testid'));
            }
          }
        }
        
        // Try finding by position - send button is usually bottom right
        const bottomRightBtns = allBtns.filter(btn => {
          const rect = btn.getBoundingClientRect();
          return rect.bottom > 700 && rect.right > 300 && rect.width < 60 && !btn.disabled;
        });
        if (bottomRightBtns.length > 0) {
          const btn = bottomRightBtns[bottomRightBtns.length - 1];
          btn.click();
          return 'bottom-right: ' + btn.getAttribute('aria-label');
        }
        
        return false;
      });
      console.log('  Send clicked:', sendClicked);
      
      if (!sendClicked) {
        // Fallback to Enter key
        await page.keyboard.press('Enter');
        console.log('  ↩️ Usé Enter como fallback');
      }
      
      await sleep(3000);
      await page.screenshot({ path: '/tmp/gemini_p4_sent.png' });

      // PASO 7: Esperar respuesta con imagen
      console.log('  📱 Paso 7: Esperando imagen de Gemini...');
      let resultImage = null;
      
      for (let attempt = 0; attempt < 12; attempt++) {
        await sleep(5000);
        console.log('  ⏳ Esperando... ('+(attempt+1)+'/12)');
        
        // Look for generated image in response
        const imgFound = await page.evaluate(() => {
          const imgs = [...document.querySelectorAll('img')];
          const candidates = imgs.filter(img => {
            const src = img.src || '';
            const rect = img.getBoundingClientRect();
            return rect.width > 100 && rect.height > 100 && 
                   (src.startsWith('blob:') || src.includes('generativelanguage') || src.includes('aiusercontent'));
          });
          return candidates.map(img => ({
            src: img.src,
            w: img.naturalWidth || img.width,
            h: img.naturalHeight || img.height
          }));
        });

        if (imgFound.length > 0) {
          console.log('  🖼️ Imagen encontrada:', imgFound[0].w, 'x', imgFound[0].h);
          
          // Download the image while browser is still open
          try {
            resultImage = await page.evaluate(async (src) => {
              const resp = await fetch(src, { credentials: 'include' });
              const blob = await resp.blob();
              return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result.split(',')[1]);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
              });
            }, imgFound[0].src);
            
            if (resultImage && resultImage.length > 1000) {
              console.log('  ✅ Imagen descargada:', resultImage.length, 'bytes base64');
              break;
            }
          } catch(e) {
            console.log('  ⚠️ Error descargando imagen, intentando screenshot...');
            // Fallback: screenshot the image element
            try {
              const imgEl = await page.$(`img[src="${imgFound[0].src}"]`);
              if (imgEl) {
                resultImage = await imgEl.screenshot({ encoding: 'base64' });
                if (resultImage) { 
                  console.log('  ✅ Screenshot del elemento de imagen');
                  break; 
                }
              }
            } catch(e2) {}
          }
        }

        // Check if still generating
        const stillLoading = await page.evaluate(() => {
          return document.querySelector('[aria-label*="loading"], [aria-label*="generando"], .loading-indicator') !== null;
        });
        if (!stillLoading && attempt > 3) break;
      }

      await page.screenshot({ path: '/tmp/gemini_p5_result.png' });
      await browser.close();
      require('fs').unlinkSync(tmpImg);

      if (resultImage && resultImage.length > 1000) {
        console.log('  ✅ Éxito! Enviando imagen al panel...');
        res.writeHead(200, corsHeaders({'Content-Type':'application/json'}));
        res.end(JSON.stringify({ data: [{ b64_json: resultImage }] }));
      } else {
        console.log('  ❌ No se pudo obtener imagen');
        res.writeHead(500, corsHeaders({'Content-Type':'application/json'}));
        res.end(JSON.stringify({ error: 'Gemini no generó imagen. Revisa /tmp/gemini_p5_result.png' }));
      }

    } catch(e) {
      console.log('  ❌ Error Gemini Web:', e.message);
      res.writeHead(500, corsHeaders({'Content-Type':'application/json'}));
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ---- PROGRAMAR POST ----  // ---- PROGRAMAR POST ----
  if (pathname === '/api/schedule-post') {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body);
      const { pageId, token, caption, imageSrc, scheduledAt, postId } = payload;
      if (!pageId || !token || !caption || !scheduledAt) {
        res.writeHead(400, corsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: 'Faltan datos' })); return;
      }
      if (new Date(scheduledAt) <= new Date()) {
        res.writeHead(400, corsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: 'La fecha debe ser en el futuro' })); return;
      }
      addScheduledPost({ postId, pageId, token, caption, imageSrc, scheduledAt, status: 'pending' });
      res.writeHead(200, corsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ success: true, scheduledAt }));
    } catch (e) {
      res.writeHead(500, corsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ---- ESTADO PROGRAMADOS ----
  if (pathname === '/api/scheduled-status') {
    res.writeHead(200, corsHeaders({ 'Content-Type': 'application/json' }));
    res.end(JSON.stringify({ posts: scheduledPosts }));
    return;
  }

  // ---- REESCRIBIR TITULO ----
  if (pathname === '/api/openai/rewrite') {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body);
      const openaiPayload = JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: payload.prompt }],
        max_tokens: 1000
      });
      const result = await httpsPost(
        'api.openai.com', '/v1/chat/completions',
        {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + OPENAI_API_KEY,
          'Content-Length': Buffer.byteLength(openaiPayload)
        },
        Buffer.from(openaiPayload)
      );
      res.writeHead(result.status, corsHeaders({ 'Content-Type': 'application/json' }));
      res.end(result.body);
    } catch (e) {
      res.writeHead(500, corsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ---- PROXY APIFY ----
  if (pathname.startsWith('/api/apify')) {
    const body = await readBody(req);
    const target = 'https://api.apify.com' + pathname.replace('/api/apify', '') + (parsedUrl.search || '');
    const targetParsed = new url.URL(target);
    const options = {
      hostname: targetParsed.hostname,
      path: targetParsed.pathname + (targetParsed.search || ''),
      method: req.method,
      headers: { 'Content-Type': 'application/json' }
    };
    const proxyReq = https.request(options, proxyRes => {
      res.writeHead(proxyRes.statusCode, corsHeaders({ 'Content-Type': 'application/json' }));
      proxyRes.pipe(res);
    });
    proxyReq.on('error', e => {
      res.writeHead(500, corsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: e.message }));
    });
    if (body) proxyReq.write(body);
    proxyReq.end();
    return;
  }

  res.writeHead(404, corsHeaders({ 'Content-Type': 'application/json' }));
  res.end(JSON.stringify({ error: 'Not found' }));
});

// Iniciar servidor y DB
connectDB().then(async () => {
  await loadGeminiKey();
  server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('  🔥 ViralPanel iniciado');
    console.log('  🌐 Puerto:', PORT);
    console.log('  ⏰ Scheduler: activo');
    console.log('');
  });
});
