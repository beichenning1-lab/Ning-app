const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');

const PORT = 3000;
const DB_FILE = './data.db';

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    token TEXT UNIQUE NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS status (
    user_id INTEGER PRIMARY KEY,
    battery INTEGER,
    charging INTEGER,
    lat REAL,
    lng REAL,
    weather TEXT,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id INTEGER NOT NULL,
    to_id INTEGER NOT NULL,
    type TEXT DEFAULT 'text',
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

const app = express();
app.use(express.json({ limit: '20mb' }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: Date.now() });
});

app.post('/api/auth', (req, res) => {
  const { deviceId, name } = req.body;
  if (!deviceId || !name) return res.status(400).json({ error: 'deviceId and name required' });

  let user = db.prepare('SELECT * FROM users WHERE device_id = ?').get(deviceId);
  if (user) {
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, user.id);
    user.name = name;
  } else {
    const token = crypto.randomBytes(32).toString('hex');
    const info = db.prepare('INSERT INTO users (device_id, name, token, created_at) VALUES (?, ?, ?, ?)')
      .run(deviceId, name, token, Date.now());
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  }
  res.json({ token: user.token, userId: user.id, name: user.name });
});

function auth(req, res, next) {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  const user = db.prepare('SELECT * FROM users WHERE token = ?').get(t);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.user = user;
  next();
}

app.post('/api/status', auth, (req, res) => {
  const { battery, charging, lat, lng, weather } = req.body;
  const now = Date.now();
  db.prepare(`
    INSERT INTO status (user_id, battery, charging, lat, lng, weather, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      battery=excluded.battery, charging=excluded.charging,
      lat=excluded.lat, lng=excluded.lng,
      weather=excluded.weather, updated_at=excluded.updated_at
  `).run(req.user.id, battery ?? null, charging ?? null, lat ?? null, lng ?? null, weather ?? null, now);

  io.emit('status', { userId: req.user.id, name: req.user.name, battery, charging, lat, lng, weather, updatedAt: now });
  res.json({ ok: true });
});

app.get('/api/users', auth, (req, res) => {
  res.json(db.prepare('SELECT id, name FROM users').all());
});

app.get('/api/status/:userId', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM status WHERE user_id = ?').get(req.params.userId) || null);
});

app.get('/api/messages/:peerId', auth, (req, res) => {
  const msgs = db.prepare(`
    SELECT * FROM messages
    WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)
    ORDER BY created_at DESC LIMIT 100
  `).all(req.user.id, req.params.peerId, req.params.peerId, req.user.id);
  res.json(msgs.reverse());
});

app.post('/api/upload', auth, (req, res) => {
  const { data } = req.body;
  if (!data || !data.startsWith('data:image/')) return res.status(400).json({ error: 'invalid image' });
  const m = data.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!m) return res.status(400).json({ error: 'bad format' });

  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const buf = Buffer.from(m[2], 'base64');
  const filename = crypto.randomBytes(16).toString('hex') + '.' + ext;
  const dir = path.join(__dirname, 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), buf);

  res.json({ url: '/uploads/' + filename });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

io.use((socket, next) => {
  const t = socket.handshake.auth.token;
  const user = db.prepare('SELECT * FROM users WHERE token = ?').get(t);
  if (!user) return next(new Error('unauthorized'));
  socket.user = user;
  next();
});

io.on('connection', (socket) => {
  console.log('online:', socket.user.name, socket.user.id);
  socket.join('user:' + socket.user.id);

  socket.on('message', (data) => {
    const { toId, type = 'text', content } = data || {};
    if (!toId || !content) return;
    const now = Date.now();
    const info = db.prepare('INSERT INTO messages (from_id, to_id, type, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(socket.user.id, toId, type, content, now);
    const msg = {
      id: info.lastInsertRowid,
      fromId: socket.user.id,
      fromName: socket.user.name,
      toId, type, content, createdAt: now
    };
    io.to('user:' + toId).emit('message', msg);
    socket.emit('message', msg);
  });

  socket.on('disconnect', () => console.log('offline:', socket.user.name));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Server on http://127.0.0.1:' + PORT);
});
