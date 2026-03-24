const express = require('express');
const cors    = require('cors');
const { Pool } = require('pg');
const http    = require('http');
const WebSocket = require('ws');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// ── Base de données ──────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// ── Middleware ───────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── Init DB ──────────────────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ppms_store (
      key   TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Insérer clés vides si absent
  await pool.query(`
    INSERT INTO ppms_store (key, value) VALUES ('config', '{}'), ('exercise', '{}')
    ON CONFLICT (key) DO NOTHING
  `);
  console.log('✅ DB initialisée');
}

// ── Broadcast WebSocket ──────────────────────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

// ── WebSocket connexion ──────────────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('WS client connecté, total:', wss.clients.size);
  ws.on('close', () => console.log('WS client déconnecté'));
});

// ── API Routes ───────────────────────────────────────────────────────────

// GET /api/config
app.get('/api/config', async (req, res) => {
  try {
    const r = await pool.query("SELECT value FROM ppms_store WHERE key='config'");
    res.json(r.rows[0]?.value || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/config
app.put('/api/config', async (req, res) => {
  try {
    await pool.query(`
      UPDATE ppms_store SET value=$1, updated_at=NOW() WHERE key='config'
    `, [JSON.stringify(req.body)]);
    broadcast({ type: 'config_updated' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/exercise
app.get('/api/exercise', async (req, res) => {
  try {
    const r = await pool.query("SELECT value FROM ppms_store WHERE key='exercise'");
    res.json(r.rows[0]?.value || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/exercise
app.put('/api/exercise', async (req, res) => {
  try {
    await pool.query(`
      UPDATE ppms_store SET value=$1, updated_at=NOW() WHERE key='exercise'
    `, [JSON.stringify(req.body)]);
    broadcast({ type: 'exercise_updated' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/exercise/person — mise à jour statut d'une seule personne
app.patch('/api/exercise/person', async (req, res) => {
  try {
    const { uid, type, ...fields } = req.body; // type = 'personnel' | 'enfants'
    const r = await pool.query("SELECT value FROM ppms_store WHERE key='exercise'");
    const ex = r.rows[0]?.value || { personnel: [], enfants: [] };
    const arr = ex[type] || [];
    const idx = arr.findIndex(p => p.uid === uid);
    if (idx >= 0) Object.assign(arr[idx], fields);
    await pool.query(`
      UPDATE ppms_store SET value=$1, updated_at=NOW() WHERE key='exercise'
    `, [JSON.stringify(ex)]);
    broadcast({ type: 'person_updated', uid, personType: type, ...fields });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/ping
app.get('/api/ping', (req, res) => res.json({ ok: true, clients: wss.clients.size }));

// ── Servir le site statique ──────────────────────────────────────────────
const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Démarrage ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  server.listen(PORT, '0.0.0.0', () => console.log(`🚀 PPMS backend sur port ${PORT}`));
}).catch(e => { console.error('Erreur initDB:', e); process.exit(1); });
