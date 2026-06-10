const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
// Node 18+ has built-in fetch — no import needed

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── DATABASE ──────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ── INIT TABLES ───────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bmt_students (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE,
      password VARCHAR(100) NOT NULL,
      board VARCHAR(20) DEFAULT 'CBSE',
      class VARCHAR(5) NOT NULL,
      state VARCHAR(50) NOT NULL,
      is_paid BOOLEAN DEFAULT FALSE,
      plan VARCHAR(20) DEFAULT 'free',
      xp INTEGER DEFAULT 0,
      streak INTEGER DEFAULT 0,
      stars INTEGER DEFAULT 0,
      total_questions INTEGER DEFAULT 0,
      questions_today INTEGER DEFAULT 0,
      last_study_day VARCHAR(30),
      last_login_date VARCHAR(30),
      parent_pin VARCHAR(10) DEFAULT '1234',
      reg_on TIMESTAMP DEFAULT NOW(),
      subjects JSONB DEFAULT '{}',
      homework JSONB DEFAULT '[]',
      exam_hist JSONB DEFAULT '[]',
      badges JSONB DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS bmt_leaderboard (
      id BIGSERIAL PRIMARY KEY,
      student_id BIGINT REFERENCES bmt_students(id),
      student_name VARCHAR(100),
      state VARCHAR(50),
      class VARCHAR(5),
      board VARCHAR(20),
      score INTEGER DEFAULT 0,
      stars INTEGER DEFAULT 0,
      xp INTEGER DEFAULT 0,
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS bmt_payments (
      id BIGSERIAL PRIMARY KEY,
      student_id BIGINT REFERENCES bmt_students(id),
      student_name VARCHAR(100),
      amount INTEGER,
      plan VARCHAR(20),
      razorpay_id VARCHAR(100),
      status VARCHAR(20) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('✅ BrightMind DB tables ready');
}

// ── HELPERS ───────────────────────────────────────
function sanitize(s) {
  return {
    id: s.id, name: s.name, board: s.board || 'CBSE',
    class: s.class, state: s.state,
    is_paid: s.is_paid || false, plan: s.plan || 'free',
    xp: s.xp || 0, streak: s.streak || 0, stars: s.stars || 0,
    total_questions: s.total_questions || 0,
    questions_today: s.questions_today || 0,
    last_study_day: s.last_study_day || null,
    parent_pin: s.parent_pin || '1234',
    reg_on: s.reg_on,
    subjects: s.subjects || {},
    homework: s.homework || [],
    exam_hist: s.exam_hist || [],
    badges: s.badges || []
  };
}

// ══════════════════════════════════════════════════
// AUTH ROUTES
// ══════════════════════════════════════════════════

// REGISTER
app.post('/api/register', async (req, res) => {
  try {
    const { name, password, board, class: cls, state } = req.body;
    if (!name || !password || !cls || !state) return res.json({ ok: false, msg: 'Please fill all fields!' });

    const exists = await pool.query('SELECT id FROM bmt_students WHERE LOWER(name)=LOWER($1)', [name]);
    if (exists.rows.length > 0) return res.json({ ok: false, msg: 'Name already taken! Try another.' });

    const result = await pool.query(
      `INSERT INTO bmt_students (name, password, board, class, state, reg_on)
       VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING *`,
      [name, password, board || 'CBSE', cls, state]
    );
    console.log(`📝 NEW STUDENT: ${name} | Class ${cls} | ${state} | ${board}`);
    res.json({ ok: true, msg: 'Account created! Please login.' });
  } catch (e) {
    console.error(e);
    res.json({ ok: false, msg: 'Server error. Please try again.' });
  }
});

// LOGIN
app.post('/api/login', async (req, res) => {
  try {
    const { name, password } = req.body;
    const result = await pool.query(
      'SELECT * FROM bmt_students WHERE LOWER(name)=LOWER($1)', [name]
    );
    if (!result.rows.length) return res.json({ ok: false, msg: 'Name not found!' });
    const student = result.rows[0];
    if (student.password !== password) return res.json({ ok: false, msg: 'Wrong password!' });

    // Reset daily counter if new day
    const today = new Date().toDateString();
    if (student.last_login_date !== today) {
      await pool.query(
        'UPDATE bmt_students SET questions_today=0, last_login_date=$1 WHERE id=$2',
        [today, student.id]
      );
      student.questions_today = 0;
      student.last_login_date = today;
    }

    console.log(`🔑 LOGIN: ${student.name} | Class ${student.class} | ${student.state}`);
    res.json({ ok: true, student: sanitize(student) });
  } catch (e) {
    console.error(e);
    res.json({ ok: false, msg: 'Server error.' });
  }
});

// SAVE PROGRESS
app.post('/api/save', async (req, res) => {
  try {
    const { id, subjects, homework, exam_hist, badges, xp, streak, stars,
            total_questions, questions_today, last_study_day, is_paid, plan, parent_pin } = req.body;
    await pool.query(
      `UPDATE bmt_students SET
        subjects=$1, homework=$2, exam_hist=$3, badges=$4,
        xp=$5, streak=$6, stars=$7, total_questions=$8,
        questions_today=$9, last_study_day=$10,
        is_paid=$11, plan=$12, parent_pin=$13
       WHERE id=$14`,
      [
        JSON.stringify(subjects || {}),
        JSON.stringify(homework || []),
        JSON.stringify(exam_hist || []),
        JSON.stringify(badges || []),
        xp || 0, streak || 0, stars || 0,
        total_questions || 0, questions_today || 0,
        last_study_day || null, is_paid || false,
        plan || 'free', parent_pin || '1234', id
      ]
    );

    // Update leaderboard
    if (exam_hist && exam_hist.length > 0) {
      const best = Math.max(...exam_hist.map(e => e.score));
      const student = await pool.query('SELECT name,state,class,board FROM bmt_students WHERE id=$1', [id]);
      if (student.rows.length) {
        const s = student.rows[0];
        await pool.query(
          `INSERT INTO bmt_leaderboard (student_id,student_name,state,class,board,score,stars,xp,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
           ON CONFLICT (student_id) DO UPDATE SET
           score=$6, stars=$7, xp=$8, updated_at=NOW()`,
          [id, s.name, s.state, s.class, s.board, best, stars || 0, xp || 0]
        ).catch(() => {}); // ignore if no unique constraint yet
      }
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.json({ ok: false });
  }
});

// GET LEADERBOARD — All India
app.get('/api/leaderboard/india', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT student_name as name, state, class, board, score, stars, xp
       FROM bmt_leaderboard ORDER BY score DESC, xp DESC LIMIT 100`
    );
    res.json({ ok: true, data: result.rows });
  } catch (e) {
    res.json({ ok: true, data: [] });
  }
});

// GET LEADERBOARD — By State
app.get('/api/leaderboard/state/:state', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT student_name as name, state, class, score, stars, xp
       FROM bmt_leaderboard WHERE state=$1 ORDER BY score DESC LIMIT 50`,
      [req.params.state]
    );
    res.json({ ok: true, data: result.rows });
  } catch (e) {
    res.json({ ok: true, data: [] });
  }
});

// PARENT LOGIN — verify by child name + PIN
app.post('/api/parent-login', async (req, res) => {
  try {
    const { child_name, pin } = req.body;
    const result = await pool.query(
      'SELECT * FROM bmt_students WHERE LOWER(name)=LOWER($1)', [child_name]
    );
    if (!result.rows.length) return res.json({ ok: false, msg: 'No student found with that name.' });
    const s = result.rows[0];
    const correctPin = s.parent_pin || '1234';
    if (pin !== correctPin) return res.json({ ok: false, msg: 'Wrong PIN! Default is 1234.' });
    console.log(`👨‍👩‍👧 PARENT LOGIN: viewing ${s.name}`);
    res.json({ ok: true, student: sanitize(s) });
  } catch (e) {
    res.json({ ok: false, msg: 'Server error.' });
  }
});

// ══════════════════════════════════════════════════
// ADMIN ROUTES
// ══════════════════════════════════════════════════

// ADMIN — Reset any student password
app.post('/api/admin/reset-password', async (req, res) => {
  try {
    const key = req.headers['x-admin-key'];
    if (key !== process.env.ADMIN_KEY) return res.status(401).json({ ok: false });
    const { name, new_password } = req.body;
    await pool.query('UPDATE bmt_students SET password=$1 WHERE LOWER(name)=LOWER($2)', [new_password, name]);
    console.log(`🛡️ ADMIN RESET PASSWORD: ${name}`);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false });
  }
});

// ADMIN — All students
app.get('/api/admin/students', async (req, res) => {
  try {
    const key = req.headers['x-admin-key'];
    if (key !== process.env.ADMIN_KEY) return res.status(401).json({ ok: false });
    const result = await pool.query(
      `SELECT id,name,board,class,state,is_paid,plan,xp,streak,stars,
              total_questions,questions_today,reg_on,
              jsonb_array_length(exam_hist) as exam_count,
              jsonb_array_length(homework) as hw_count
       FROM bmt_students ORDER BY reg_on DESC`
    );
    res.json({ ok: true, students: result.rows });
  } catch (e) {
    res.json({ ok: false });
  }
});

// ADMIN — Stats summary
app.get('/api/admin/stats', async (req, res) => {
  try {
    const key = req.headers['x-admin-key'];
    if (key !== process.env.ADMIN_KEY) return res.status(401).json({ ok: false });
    const total = await pool.query('SELECT COUNT(*) FROM bmt_students');
    const paid  = await pool.query('SELECT COUNT(*) FROM bmt_students WHERE is_paid=true');
    const exams = await pool.query('SELECT SUM(jsonb_array_length(exam_hist)) FROM bmt_students');
    const byState = await pool.query(
      'SELECT state, COUNT(*) as count FROM bmt_students GROUP BY state ORDER BY count DESC'
    );
    res.json({
      ok: true,
      total: parseInt(total.rows[0].count),
      paid:  parseInt(paid.rows[0].count),
      exams: parseInt(exams.rows[0].sum) || 0,
      revenue: parseInt(paid.rows[0].count) * 199,
      byState: byState.rows
    });
  } catch (e) {
    res.json({ ok: false });
  }
});

// PAYMENT WEBHOOK (Razorpay — add later)
app.post('/api/payment/verify', async (req, res) => {
  try {
    const { student_id, student_name, amount, plan, razorpay_id } = req.body;
    await pool.query(
      `INSERT INTO bmt_payments (student_id,student_name,amount,plan,razorpay_id,status)
       VALUES ($1,$2,$3,$4,$5,'success')`,
      [student_id, student_name, amount, plan, razorpay_id]
    );
    await pool.query(
      'UPDATE bmt_students SET is_paid=true, plan=$1 WHERE id=$2',
      [plan, student_id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false });
  }
});

// ══════════════════════════════════════════════════
// AI PROXY — Routes Anthropic calls securely
// ══════════════════════════════════════════════════
app.post('/api/ai', async (req, res) => {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.json(data);
  } catch (e) {
    console.error('AI proxy error:', e);
    res.status(500).json({ error: 'AI service error' });
  }
});

// RESET PASSWORD
app.post('/api/reset-password', async (req, res) => {
  try {
    const { name, new_password } = req.body;
    if (!name || !new_password) return res.json({ ok: false, msg: 'Name and new password required!' });
    if (new_password.length < 4) return res.json({ ok: false, msg: 'Password too short!' });
    const exists = await pool.query('SELECT id FROM bmt_students WHERE LOWER(name)=LOWER($1)', [name]);
    if (!exists.rows.length) return res.json({ ok: false, msg: 'No student found with that name. Check spelling!' });
    await pool.query('UPDATE bmt_students SET password=$1 WHERE LOWER(name)=LOWER($2)', [new_password, name]);
    console.log(`🔑 PASSWORD RESET: ${name}`);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.json({ ok: false, msg: 'Server error. Try again.' });
  }
});

// HEALTH CHECK
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'BrightMind Teacher API', time: new Date().toISOString() });
});

// SERVE FRONTEND
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── START ─────────────────────────────────────────
const PORT = process.env.PORT || 3001;
initDB().then(() => {
  app.listen(PORT, () => console.log(`🧠 BrightMind Teacher server running on port ${PORT}`));
}).catch(e => { console.error('DB init failed:', e); process.exit(1); });
