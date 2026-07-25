const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = 8000;

// SQLite setup
const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT,
    vehicle_make TEXT NOT NULL,
    vehicle_model TEXT NOT NULL,
    vehicle_year TEXT,
    service_type TEXT NOT NULL,
    preferred_date TEXT NOT NULL,
    preferred_time TEXT NOT NULL,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS work_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER,
    customer_name TEXT NOT NULL,
    vehicle TEXT NOT NULL,
    service TEXT NOT NULL,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'not-started',
    assigned_to TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (booking_id) REFERENCES bookings(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS work_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_id INTEGER NOT NULL,
    update_text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (work_id) REFERENCES work_progress(id)
  )
`);

app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Serve static files
app.use(express.static(__dirname));

// ============ API ROUTES ============

// Get all bookings
app.get('/api/bookings', (req, res) => {
  const { status } = req.query;
  let bookings;
  if (status && status !== 'all') {
    bookings = db.prepare('SELECT * FROM bookings WHERE status = ? ORDER BY created_at DESC').all(status);
  } else {
    bookings = db.prepare('SELECT * FROM bookings ORDER BY created_at DESC').all();
  }
  res.json(bookings);
});

// Get dashboard stats
app.get('/api/bookings/stats', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as count FROM bookings').get().count;
  const pending = db.prepare("SELECT COUNT(*) as count FROM bookings WHERE status = 'pending'").get().count;
  const confirmed = db.prepare("SELECT COUNT(*) as count FROM bookings WHERE status = 'confirmed'").get().count;
  const inProgress = db.prepare("SELECT COUNT(*) as count FROM bookings WHERE status = 'in-progress'").get().count;
  const completed = db.prepare("SELECT COUNT(*) as count FROM bookings WHERE status = 'completed'").get().count;
  const cancelled = db.prepare("SELECT COUNT(*) as count FROM bookings WHERE status = 'cancelled'").get().count;
  res.json({ total, pending, confirmed, inProgress, completed, cancelled });
});

// Create booking
app.post('/api/bookings', (req, res) => {
  const { customer_name, phone, email, vehicle_make, vehicle_model, vehicle_year, service_type, preferred_date, preferred_time, notes } = req.body;

  if (!customer_name || !phone || !vehicle_make || !vehicle_model || !service_type || !preferred_date || !preferred_time) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const stmt = db.prepare(`
    INSERT INTO bookings (customer_name, phone, email, vehicle_make, vehicle_model, vehicle_year, service_type, preferred_date, preferred_time, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(customer_name, phone, email || null, vehicle_make, vehicle_model, vehicle_year || null, service_type, preferred_date, preferred_time, notes || null);
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(booking);
});

// Update booking status
app.patch('/api/bookings/:id/status', (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const validStatuses = ['pending', 'confirmed', 'in-progress', 'completed', 'cancelled'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(status, id);
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  res.json(booking);
});

// Delete booking
app.delete('/api/bookings/:id', (req, res) => {
  const { id } = req.params;
  db.prepare('DELETE FROM bookings WHERE id = ?').run(id);
  res.status(204).send();
});

// ============ WORK PROGRESS ROUTES ============

// Get all work entries
app.get('/api/work', (req, res) => {
  const { status } = req.query;
  let entries;
  if (status && status !== 'all') {
    entries = db.prepare('SELECT * FROM work_progress WHERE status = ? ORDER BY created_at DESC').all(status);
  } else {
    entries = db.prepare('SELECT * FROM work_progress ORDER BY created_at DESC').all();
  }
  // Attach updates for each entry
  entries.forEach(entry => {
    entry.updates = db.prepare('SELECT * FROM work_updates WHERE work_id = ? ORDER BY created_at DESC').all(entry.id);
  });
  res.json(entries);
});

// Create work entry
app.post('/api/work', (req, res) => {
  const { booking_id, customer_name, vehicle, service, notes, assigned_to } = req.body;
  if (!customer_name || !vehicle || !service) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const result = db.prepare(`
    INSERT INTO work_progress (booking_id, customer_name, vehicle, service, notes, assigned_to)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(booking_id || null, customer_name, vehicle, service, notes || null, assigned_to || null);
  const entry = db.prepare('SELECT * FROM work_progress WHERE id = ?').get(result.lastInsertRowid);
  entry.updates = [];
  res.status(201).json(entry);
});

// Update work status
app.patch('/api/work/:id/status', (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const valid = ['not-started', 'in-progress', 'waiting-parts', 'ready-pickup', 'completed'];
  if (!valid.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  db.prepare('UPDATE work_progress SET status = ? WHERE id = ?').run(status, id);
  const entry = db.prepare('SELECT * FROM work_progress WHERE id = ?').get(id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  entry.updates = db.prepare('SELECT * FROM work_updates WHERE work_id = ? ORDER BY created_at DESC').all(id);
  res.json(entry);
});

// Add work update (note)
app.post('/api/work/:id/updates', (req, res) => {
  const { id } = req.params;
  const { update_text } = req.body;
  if (!update_text) {
    return res.status(400).json({ error: 'Update text is required' });
  }
  db.prepare('INSERT INTO work_updates (work_id, update_text) VALUES (?, ?)').run(id, update_text);
  const updates = db.prepare('SELECT * FROM work_updates WHERE work_id = ? ORDER BY created_at DESC').all(id);
  res.status(201).json(updates);
});

// Delete work entry
app.delete('/api/work/:id', (req, res) => {
  const { id } = req.params;
  db.prepare('DELETE FROM work_updates WHERE work_id = ?').run(id);
  db.prepare('DELETE FROM work_progress WHERE id = ?').run(id);
  res.status(204).send();
});

// Serve index.html for any non-API route
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    return res.sendFile(path.join(__dirname, 'index.html'));
  }
  next();
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Motocrew server running on port ${PORT}`);
});
