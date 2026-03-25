const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const http = require('http');
const path = require('path');
const fs = require('fs/promises');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

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

app.use(cors());
app.use(express.json({ limit: '10mb' }));

wss.on('connection', (ws) => {
  console.log('WS client connected. Total:', wss.clients.size);
  ws.on('close', () => console.log('WS client disconnected.'));
});

app.get('/api/config', async (req, res) => {
  try {
    res.json(await getStoreValue('config'));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/config', async (req, res) => {
  try {
    await setStoreValue('config', req.body);
    broadcast({ type: 'config_updated' });
    res.json({ ok: true, storageMode });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/exercise', async (req, res) => {
  try {
    res.json(await getStoreValue('exercise'));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/exercise', async (req, res) => {
  try {
    await setStoreValue('exercise', req.body);
    broadcast({ type: 'exercise_updated' });
    res.json({ ok: true, storageMode });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/exercise/person', async (req, res) => {
  try {
    const { uid, type, fields } = await patchExercisePerson(req.body);
    broadcast({ type: 'person_updated', uid, personType: type, ...fields });
    res.json({ ok: true, storageMode });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/ping', (req, res) => {
  res.json({ ok: true, clients: wss.clients.size, storageMode });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

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
  if (pool) {
    await pool.end().catch(() => {});
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
