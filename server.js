const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const http = require('http');
const path = require('path');
const fs = require('fs/promises');
const WebSocket = require('ws');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const JWT_SECRET = process.env.JWT_SECRET || 'ppms-secret-key-change-in-production-2026';
const ADMIN_EMAIL = 'admin@ppms.fr';
const ADMIN_PASSWORD = process.env.ADMIN_DEFAULT_PASSWORD || 'Ppms2026!';

const DATA_DIR = path.join(__dirname, '.data');
const DATA_FILE = path.join(DATA_DIR, 'ppms-store.json');

let pool = null;
let storageMode = 'file';
let fileStore = null;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeStore(value = {}) {
  return {
    config: isPlainObject(value.config) ? value.config : {},
    exercise: isPlainObject(value.exercise) ? value.exercise : {}
  };
}

async function persistFileStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(fileStore, null, 2), 'utf8');
}

async function loadFileStore() {
  if (fileStore) return fileStore;
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    fileStore = normalizeStore(JSON.parse(raw));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('Local store unreadable, resetting it:', error.message);
    }
    fileStore = normalizeStore();
    await persistFileStore();
  }
  return fileStore;
}

async function initPostgres(candidatePool) {
  await candidatePool.query(`
    CREATE TABLE IF NOT EXISTS ppms_store (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await candidatePool.query(`
    INSERT INTO ppms_store (key, value) VALUES ('config', '{}'), ('exercise', '{}')
    ON CONFLICT (key) DO NOTHING
  `);

  // Users table
  await candidatePool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      nom TEXT NOT NULL DEFAULT '',
      prenom TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Create default admin
  const existing = await candidatePool.query('SELECT id FROM users WHERE email = $1', [ADMIN_EMAIL]);
  if (existing.rows.length === 0) {
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    await candidatePool.query(
      'INSERT INTO users (email, password, nom, prenom, role) VALUES ($1, $2, $3, $4, $5)',
      [ADMIN_EMAIL, hash, 'Admin', 'PPMS', 'admin']
    );
    console.log('Default admin created:', ADMIN_EMAIL);
  }
}

async function initStorage() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.warn(`DATABASE_URL is not set. Using local file storage: ${DATA_FILE}`);
    await loadFileStore();
    return;
  }
  const candidatePool = new Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false }
  });
  try {
    await initPostgres(candidatePool);
    pool = candidatePool;
    storageMode = 'postgres';
    console.log('Storage mode: postgres');
  } catch (error) {
    console.error('Postgres init failed, falling back to local file storage:', error.message);
    await candidatePool.end().catch(() => {});
    await loadFileStore();
  }
}

async function getStoreValue(key) {
  if (pool) {
    const result = await pool.query('SELECT value FROM ppms_store WHERE key = $1', [key]);
    return result.rows[0]?.value || {};
  }
  const store = await loadFileStore();
  return store[key] || {};
}

async function setStoreValue(key, value) {
  if (pool) {
    await pool.query(
      'UPDATE ppms_store SET value = $1, updated_at = NOW() WHERE key = $2',
      [JSON.stringify(value), key]
    );
    return;
  }
  const store = await loadFileStore();
  store[key] = value;
  fileStore = store;
  await persistFileStore();
}

async function patchExercisePerson(payload) {
  const { uid, type, ...fields } = payload;
  const exercise = await getStoreValue('exercise');
  if (!Array.isArray(exercise.personnel)) exercise.personnel = [];
  if (!Array.isArray(exercise.enfants)) exercise.enfants = [];
  if (!Array.isArray(exercise[type])) exercise[type] = [];
  const index = exercise[type].findIndex((person) => person.uid === uid);
  if (index >= 0) Object.assign(exercise[type][index], fields);
  await setStoreValue('exercise', exercise);
  return { uid, type, fields };
}

function broadcast(data) {
  const message = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  });
}

// ── Auth middleware ──
function authenticateToken(req, res, next) {
  // Skip auth in file mode (local dev)
  if (storageMode === 'file') return next();

  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token requis' });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }
}

function requireAdmin(req, res, next) {
  if (storageMode === 'file') return next();
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Accès réservé aux administrateurs' });
  }
  next();
}

// ── Middleware ──
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── Static files (no auth needed) ──
app.use(express.static(path.join(__dirname, 'public')));

// ── WebSocket ──
wss.on('connection', (ws) => {
  console.log('WS client connected. Total:', wss.clients.size);
  ws.on('close', () => console.log('WS client disconnected.'));
});

// ── Auth routes (public) ──
app.post('/api/auth/login', async (req, res) => {
  try {
    if (!pool) return res.json({ token: 'dev-mode', user: { id: 0, email: 'dev', nom: 'Dev', prenom: 'Mode', role: 'admin' } });

    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

    const payload = { id: user.id, email: user.email, nom: user.nom, prenom: user.prenom, role: user.role };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });

    res.json({ token, user: payload });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Protected API routes ──
app.use('/api', authenticateToken);

app.get('/api/auth/me', (req, res) => {
  res.json(req.user);
});

// ── Admin routes ──
app.get('/api/auth/users', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, email, nom, prenom, role, created_at FROM users ORDER BY nom, prenom');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/users', requireAdmin, async (req, res) => {
  try {
    const { email, password, nom, prenom, role } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });

    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, password, nom, prenom, role) VALUES ($1, $2, $3, $4, $5) RETURNING id, email, nom, prenom, role, created_at',
      [email.toLowerCase().trim(), hash, nom || '', prenom || '', role || 'user']
    );
    res.json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'Cet email existe déjà' });
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/auth/users/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (id === req.user.id) return res.status(400).json({ error: 'Vous ne pouvez pas supprimer votre propre compte' });

    await pool.query('DELETE FROM users WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Data API routes (protected) ──
app.get('/api/config', async (req, res) => {
  try { res.json(await getStoreValue('config')); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/config', async (req, res) => {
  try {
    await setStoreValue('config', req.body);
    broadcast({ type: 'config_updated' });
    res.json({ ok: true, storageMode });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/exercise', async (req, res) => {
  try { res.json(await getStoreValue('exercise')); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/exercise', async (req, res) => {
  try {
    await setStoreValue('exercise', req.body);
    broadcast({ type: 'exercise_updated' });
    res.json({ ok: true, storageMode });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.patch('/api/exercise/person', async (req, res) => {
  try {
    const { uid, type, fields } = await patchExercisePerson(req.body);
    broadcast({ type: 'person_updated', uid, personType: type, ...fields });
    res.json({ ok: true, storageMode });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/ping', (req, res) => {
  res.json({ ok: true, clients: wss.clients.size, storageMode });
});

// ── Fallback route ──
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ──
const PORT = process.env.PORT || 3000;

initStorage()
  .then(() => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`PPMS backend listening on port ${PORT} (${storageMode})`);
    });
  })
  .catch((error) => {
    console.error('Fatal startup error:', error);
    process.exit(1);
  });

async function shutdown() {
  if (pool) await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
