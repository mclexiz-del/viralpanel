const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const MONGODB_URI = process.env.MONGODB_URI || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AIzaSyCUZyd7mIt_1lin3LqyuP2oAKa9Nlvr37E';

// ---- MONGODB ----
let db = null;

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

      // Enriquecer el prompt automáticamente para mejores resultados
      const enhancedPrompt = `${prompt}. Important: maintain the original composition, keep all people and faces exactly as they are, preserve the original image dimensions and aspect ratio, output in the highest quality possible.`;

      console.log('  📥 Descargando imagen...');
      const { buffer: imgBuffer, mime: imgMime } = await getImageBuffer(imageUrl);
      const ext = imgMime.includes('png') ? 'png' : 'jpeg';
      const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';

      // Intentar con 1024x1024 primero (máximo soportado para edits)
      console.log('  🤖 Enviando a gpt-image-1 (quality: high)...');
      const boundary = '----FormBoundary' + Math.random().toString(36).substr(2);
      const formData = buildMultipart(
        boundary,
        { model: 'gpt-image-1', prompt: enhancedPrompt, size: '1024x1024', quality: 'high' },
        'image[]', imgBuffer, 'image.' + ext, mimeType
      );
      const result = await httpsPost(
        'api.openai.com', '/v1/images/edits',
        {
          'Authorization': 'Bearer ' + OPENAI_API_KEY,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': formData.length
        },
        formData
      );
      console.log('  ✅ OpenAI respondió:', result.status);
      res.writeHead(result.status, corsHeaders({ 'Content-Type': 'application/json' }));
      res.end(result.body);
    } catch (e) {
      res.writeHead(500, corsHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ---- EDITAR IMAGEN CON GEMINI ----
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

      console.log('  🔮 Enviando a Gemini imagen-edit...');

      const geminiPayload = JSON.stringify({
        contents: [{
          parts: [
            { text: prompt + '. Maintain original composition, keep all people and faces exactly as they are, output highest quality.' },
            { inline_data: { mime_type: mimeType, data: base64Image } }
          ]
        }],
        generationConfig: {
          response_modalities: ['IMAGE', 'TEXT'],
          temperature: 1,
          topP: 0.95,
          topK: 32,
          maxOutputTokens: 8192
        }
      });

      const geminiResult = await httpsPost(
        'generativelanguage.googleapis.com',
        `/v1beta/models/gemini-2.5-flash-image:generateContent?key=${GEMINI_API_KEY}`,
        {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(geminiPayload)
        },
        Buffer.from(geminiPayload)
      );

      console.log('  ✅ Gemini respondió:', geminiResult.status);
      const geminiData = JSON.parse(geminiResult.body);

      // Extract image from response
      let imageBase64 = null;
      if (geminiData.candidates && geminiData.candidates[0]) {
        const parts = geminiData.candidates[0].content?.parts || [];
        for (const part of parts) {
          if (part.inline_data?.mime_type?.startsWith('image/')) {
            imageBase64 = part.inline_data.data;
            break;
          }
        }
      }

      if (imageBase64) {
        res.writeHead(200, corsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({
          data: [{ b64_json: imageBase64 }]
        }));
      } else {
        res.writeHead(500, corsHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: 'Gemini no devolvió imagen', raw: geminiData }));
      }

    } catch (e) {
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
        const { buffer: imgBuffer, mime: imgMime } = await getImageBuffer(imageSrc);
        const ext = imgMime.includes('png') ? 'png' : 'jpg';
        const boundary = '----FBBoundary' + Math.random().toString(36).substr(2);
        const formData = buildMultipart(
          boundary,
          { message: caption, access_token: token },
          'source', imgBuffer, 'image.' + ext, imgMime.split(';')[0]
        );
        fbResult = await httpsPost(
          'graph.facebook.com', `/${pageId}/photos`,
          { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': formData.length },
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

  // ---- PROGRAMAR POST ----
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
connectDB().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('  🔥 ViralPanel iniciado');
    console.log('  🌐 Puerto:', PORT);
    console.log('  ⏰ Scheduler: activo');
    console.log('');
  });
});
