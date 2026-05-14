require('dotenv').config();
const express = require('express');
const { MongoClient, GridFSBucket } = require('mongodb');
const multer = require('multer');
const cors = require('cors');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors());

const MONGO_URI = process.env.MONGO_URI;
const PORT = process.env.PORT || 3000;
const GROQ_KEY = process.env.GROQ_KEY || '';
const OPENROUTER_KEY = process.env.OPENROUTER_KEY || '';
const CF_URL = process.env.CF_URL || ''; // Cloudflare Worker URL

let db, bucket;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

MongoClient.connect(MONGO_URI)
  .then(client => {
    db = client.db('herspace');
    bucket = new GridFSBucket(db, { bucketName: 'audios' });
    console.log('✅ MongoDB connected');
  })
  .catch(err => console.error('❌ MongoDB:', err));

// Serve static HTML files
app.use(express.static(__dirname));
app.get('/api/status', (req, res) => res.json({ status: 'her space API 💗' }));

// ════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════
app.get('/api/config', async (req, res) => {
  try {
    const doc = await db.collection('config').findOne({ _id: 'main' });
    res.json(doc ? doc.data : null);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/config', async (req, res) => {
  try {
    await db.collection('config').updateOne(
      { _id: 'main' },
      { $set: { data: req.body, updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════
// MANUAL TRAINING NOTES
// ════════════════════════════════════════
app.get('/api/training', async (req, res) => {
  try {
    const doc = await db.collection('training').findOne({ _id: 'notes' });
    res.json(doc ? doc.notes : []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/training', async (req, res) => {
  try {
    await db.collection('training').updateOne(
      { _id: 'notes' },
      { $set: { notes: req.body.notes, updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════
// AUDIO FILES (GridFS)
// ════════════════════════════════════════

// Upload audio + transcript
app.post('/api/audio', upload.single('audio'), async (req, res) => {
  try {
    const { transcript, title, mood } = req.body;
    if (!req.file) return res.status(400).json({ error: 'no audio file' });

    const filename = Date.now() + '_' + req.file.originalname;
    const uploadStream = bucket.openUploadStream(filename, {
      metadata: { transcript, title, mood, originalName: req.file.originalname, uploadedAt: new Date() }
    });

    uploadStream.end(req.file.buffer);

    uploadStream.on('finish', async () => {
      const fileId = uploadStream.id.toString();
      // Save metadata to collection for easy querying
      await db.collection('audio_meta').insertOne({
        fileId, filename, transcript: transcript || '', title: title || filename,
        mood: mood || 'neutral', uploadedAt: new Date(), usageCount: 0
      });
      res.json({ ok: true, fileId, filename });
    });

    uploadStream.on('error', (e) => res.status(500).json({ error: e.message }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get all audio metadata
app.get('/api/audio', async (req, res) => {
  try {
    const audios = await db.collection('audio_meta').find({}).sort({ uploadedAt: -1 }).toArray();
    res.json(audios);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Stream audio file
app.get('/api/audio/:fileId', async (req, res) => {
  try {
    const { ObjectId } = require('mongodb');
    const fileId = new ObjectId(req.params.fileId);
    const files = await db.collection('audios.files').findOne({ _id: fileId });
    if (!files) return res.status(404).json({ error: 'not found' });
    res.set('Content-Type', 'audio/mpeg');
    const downloadStream = bucket.openDownloadStream(fileId);
    downloadStream.pipe(res);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Delete audio
app.delete('/api/audio/:fileId', async (req, res) => {
  try {
    const { ObjectId } = require('mongodb');
    await bucket.delete(new ObjectId(req.params.fileId));
    await db.collection('audio_meta').deleteOne({ fileId: req.params.fileId });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════
// AI PROXY — Groq → OpenRouter fallback
// + human timing + response style
// ════════════════════════════════════════
app.post('/api/chat', async (req, res) => {
  const { messages, system, userId } = req.body;
  if (!messages) return res.status(400).json({ error: 'messages required' });

  // Get user status from Cloudflare
  let userStatus = { trusted: 0, roast_mode: 0, warn_count: 0 };
  if (CF_URL && userId) {
    try {
      const r = await fetch(CF_URL + '/api/user/' + userId);
      if (r.ok) userStatus = await r.json() || userStatus;
    } catch {}
  }

  // Get training notes + audio transcripts for context
  let trainingCtx = '';
  try {
    const doc = await db.collection('training').findOne({ _id: 'notes' });
    const notes = doc ? doc.notes : [];
    if (notes.length) {
      trainingCtx = '\n\nThings I personally know/remember:\n' + notes.map(n => '- ' + n.content).join('\n');
    }
    // Add audio transcripts as things she's said before
    const audios = await db.collection('audio_meta').find({}).limit(20).toArray();
    if (audios.length) {
      trainingCtx += '\n\nVoice notes I\'ve sent before (use naturally when relevant):\n' +
        audios.map(a => `- [audio: ${a.title}] "${a.transcript}"`).join('\n');
    }
  } catch {}

  // Decide human-like delay (return to frontend, don't wait here)
  const lastMsg = messages[messages.length - 1]?.content || '';
  const delay = calcDelay(lastMsg, userStatus);

  const full = system ? [{ role: 'system', content: system + trainingCtx }, ...messages] : messages;

  // Try Groq
  if (GROQ_KEY) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: full, max_tokens: 120, temperature: 0.95 })
      });
      if (r.ok) {
        const d = await r.json();
        const reply = d.choices?.[0]?.message?.content;
        if (reply) return res.json({ reply: cleanReply(reply), delay, source: 'groq' });
      }
    } catch(e) { console.log('Groq failed:', e.message); }
  }

  // Fallback OpenRouter
  if (OPENROUTER_KEY) {
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + OPENROUTER_KEY,
          'HTTP-Referer': 'https://herspace.app',
          'X-Title': 'her space'
        },
        body: JSON.stringify({ model: 'meta-llama/llama-3.3-70b-instruct', messages: full, max_tokens: 120, temperature: 0.95 })
      });
      if (r.ok) {
        const d = await r.json();
        const reply = d.choices?.[0]?.message?.content;
        if (reply) return res.json({ reply: cleanReply(reply), delay, source: 'openrouter' });
      }
    } catch(e) { console.log('OpenRouter failed:', e.message); }
  }

  res.status(503).json({ error: 'ai unavailable' });
});

// ── Human delay calculator ──
function calcDelay(lastMsg, userStatus) {
  const len = lastMsg.length;
  const isQuestion = lastMsg.includes('?');
  const isBoring = len < 10 && !isQuestion;
  const isLong = len > 100;
  const isVeryEngaging = isQuestion && len > 30;

  // trusted people get faster replies
  const multiplier = userStatus.trusted ? 0.4 : 1;

  let baseDelay;
  if (isBoring) baseDelay = 8 * 60 * 1000 + Math.random() * 20 * 60 * 1000;       // 8-28 min
  else if (isVeryEngaging) baseDelay = 1 * 60 * 1000 + Math.random() * 4 * 60 * 1000; // 1-5 min
  else if (isLong) baseDelay = 3 * 60 * 1000 + Math.random() * 8 * 60 * 1000;      // 3-11 min
  else baseDelay = 2 * 60 * 1000 + Math.random() * 10 * 60 * 1000;                 // 2-12 min

  return Math.floor(baseDelay * multiplier);
}

// ── Clean reply — remove AI-isms ──
function cleanReply(text) {
  return text
    .replace(/^(sure!?|of course!?|absolutely!?|certainly!?|great!?|wow!?)\s*/gi, '')
    .replace(/\bas an ai\b.*?[.!]/gi, '')
    .replace(/\bi('m| am) (an? )?(ai|language model|chatbot|assistant)\b.*?[.!]/gi, '')
    .replace(/\bi (can't|cannot) (actually )?/gi, "i don't ")
    .trim();
}

app.listen(PORT, () => console.log(`🚀 Port ${PORT}`));
