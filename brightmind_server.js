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
      email VARCHAR(150) UNIQUE,
      mobile VARCHAR(15),
      is_paid BOOLEAN DEFAULT FALSE,
      plan VARCHAR(20) DEFAULT 'free',
      subscription_type VARCHAR(20) DEFAULT 'monthly',
      subscription_start TIMESTAMP,
      subscription_end TIMESTAMP,
      next_due_date TIMESTAMP,
      reminder_sent BOOLEAN DEFAULT FALSE,
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

    -- Add columns if not exists (for existing deployments)
    ALTER TABLE bmt_students ADD COLUMN IF NOT EXISTS mobile VARCHAR(15);
    ALTER TABLE bmt_students ADD COLUMN IF NOT EXISTS stream VARCHAR(20) DEFAULT 'science';
    ALTER TABLE bmt_students ADD COLUMN IF NOT EXISTS email VARCHAR(150);
    ALTER TABLE bmt_students ADD COLUMN IF NOT EXISTS subscription_type VARCHAR(20) DEFAULT 'monthly';
    ALTER TABLE bmt_students ADD COLUMN IF NOT EXISTS subscription_start TIMESTAMP;
    ALTER TABLE bmt_students ADD COLUMN IF NOT EXISTS subscription_end TIMESTAMP;
    ALTER TABLE bmt_students ADD COLUMN IF NOT EXISTS next_due_date TIMESTAMP;
    ALTER TABLE bmt_students ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN DEFAULT FALSE;
    ALTER TABLE bmt_students ADD COLUMN IF NOT EXISTS stream VARCHAR(20) DEFAULT 'science';
    CREATE UNIQUE INDEX IF NOT EXISTS bmt_students_email_unique ON bmt_students(email) WHERE email IS NOT NULL;

    CREATE TABLE IF NOT EXISTS bmt_support (
      id BIGSERIAL PRIMARY KEY,
      student_id BIGINT,
      student_name VARCHAR(100),
      email VARCHAR(150),
      plan VARCHAR(20),
      issue_type VARCHAR(50),
      message TEXT,
      status VARCHAR(20) DEFAULT 'open',
      created_at TIMESTAMP DEFAULT NOW()
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

    CREATE TABLE IF NOT EXISTS bmt_audit_log (
      id BIGSERIAL PRIMARY KEY,
      student_id BIGINT,
      student_name VARCHAR(100),
      action VARCHAR(50),
      details JSONB DEFAULT '{}',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS bmt_sessions (
      id BIGSERIAL PRIMARY KEY,
      student_id BIGINT,
      student_name VARCHAR(100),
      class VARCHAR(5),
      state VARCHAR(50),
      login_at TIMESTAMP DEFAULT NOW(),
      logout_at TIMESTAMP,
      duration_minutes INTEGER,
      questions_in_session INTEGER DEFAULT 0,
      subjects_studied JSONB DEFAULT '[]'
    );
  `);
  console.log('✅ BrightMind DB tables ready');
}

// ── HELPERS ───────────────────────────────────────
function sanitize(s) {
  return {
    id: s.id, name: s.name, email: s.email||null, board: s.board || 'CBSE',
    class: s.class, state: s.state, stream: s.stream || 'science', stream: s.stream || 'science',
    is_paid: s.is_paid || false, plan: s.plan || 'free',
    subscription_type: s.subscription_type || 'monthly',
    sub_expiry: s.subscription_end || null,
    expiry: s.subscription_end || null,
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
    const { name, password, board, class: cls, state, mobile, email, stream } = req.body;
    if (!name || !password || !cls || !state) return res.json({ ok: false, msg: 'Please fill all fields!' });

    // Check name taken
    const exists = await pool.query('SELECT id FROM bmt_students WHERE LOWER(name)=LOWER($1)', [name]);
    if (exists.rows.length > 0) return res.json({ ok: false, msg: 'Name already taken! Try a different name.' });

    // Check email already used — prevents free trial abuse
    if (email) {
      const emailExists = await pool.query('SELECT id, name FROM bmt_students WHERE LOWER(email)=LOWER($1)', [email]);
      if (emailExists.rows.length > 0) {
        return res.json({ ok: false, msg: `This email already has an account (${emailExists.rows[0].name}). Each email gets one free trial. Please login to your existing account!` });
      }
    }

    await pool.query(
      `INSERT INTO bmt_students (name, password, board, class, state, email, mobile, stream, reg_on)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
      [name, password, board || 'CBSE', cls, state, email || null, mobile || null, stream || 'science']
    );

    // Audit log
    await pool.query(
      `INSERT INTO bmt_audit_log (student_name, action, details)
       VALUES ($1,'REGISTER',$2)`,
      [name, JSON.stringify({ class: cls, state, board, mobile: mobile ? mobile.substring(0,6)+'****' : 'not provided' })]
    ).catch(()=>{});

    console.log(`📝 NEW STUDENT: ${name} | Class ${cls} | ${state} | Mobile: ${mobile||'not given'}`);
    res.json({ ok: true, msg: 'Account created! Please login.' });
  } catch (e) {
    console.error(e);
    res.json({ ok: false, msg: 'Server error. Please try again.' });
  }
});

// LOGIN
app.post('/api/login', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    // Support login by email or name
    const query = email 
      ? 'SELECT * FROM bmt_students WHERE LOWER(email)=LOWER($1)'
      : 'SELECT * FROM bmt_students WHERE LOWER(name)=LOWER($1)';
    const identifier = email || name;
    const result = await pool.query(query, [identifier]);
    if (!result.rows.length) return res.json({ ok: false, msg: email ? 'Email not found! Please check your email or register.' : 'Name not found!' });
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

    console.log(`🔑 LOGIN: ${student.name} | ${student.email||'no email'} | Class ${student.class} | ${student.state}`);

    // Log to audit
    await pool.query(
      `INSERT INTO bmt_audit_log (student_id, student_name, action, details)
       VALUES ($1, $2, 'LOGIN', $3)`,
      [student.id, student.name, JSON.stringify({
        email: student.email||'not provided',
        class: student.class, state: student.state,
        plan: student.is_paid ? 'PAID' : 'FREE',
        ip: req.ip, time: new Date().toISOString()
      })]
    ).catch(()=>{});

    // Start session
    await pool.query(
      `INSERT INTO bmt_sessions (student_id, student_name, class, state)
       VALUES ($1, $2, $3, $4)`,
      [student.id, student.name, student.class, student.state]
    ).catch(()=>{});
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
      `SELECT id,name,board,class,state,is_paid,plan,subscription_type,subscription_end,xp,streak,stars,
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

// CREATE RAZORPAY ORDER (proper integration)
app.post('/api/payment/create-order', async (req, res) => {
  try {
    const { amount, plan, student_id, student_name, subscription_type } = req.body;
    const RZP_KEY = process.env.RAZORPAY_KEY_ID || 'rzp_live_T0ELMmLSIlgcLq';
    const RZP_SECRET = process.env.RAZORPAY_KEY_SECRET || process.env.RAZORPAY_SECRET || '';
    
    if (!RZP_SECRET) {
      console.error('❌ RAZORPAY_KEY_SECRET not set in environment!');
      // Still try — maybe Razorpay accepts key-only for order creation
    }
    
    const orderRes = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(RZP_KEY + ':' + RZP_SECRET).toString('base64')
      },
      body: JSON.stringify({
        amount: amount * 100,
        currency: 'INR',
        receipt: 'bmt_' + student_id + '_' + Date.now(),
        notes: { student_id: String(student_id), student_name, plan, subscription_type }
      })
    });
    const order = await orderRes.json();
    if (order.error) {
      console.error('Razorpay order error:', order.error);
      // Fallback: return ok without order_id so Razorpay opens without order
      return res.json({ ok: true, order_id: null, amount: amount * 100, fallback: true });
    }
    console.log('📋 ORDER: ' + order.id + ' | ₹' + amount + ' | ' + student_name);
    res.json({ ok: true, order_id: order.id, amount: order.amount });
  } catch (e) {
    console.error('Order creation error:', e);
    res.json({ ok: false, msg: 'Could not create order' });
  }
});

// PAYMENT VERIFY
app.post('/api/payment/verify', async (req, res) => {
  try {
    const { student_id, student_name, amount, plan, razorpay_id, subscription_type } = req.body;

    // Capture the payment via Razorpay API to prevent auto-refund
    const RZP_KEY2 = process.env.RAZORPAY_KEY_ID || 'rzp_live_T0ELMmLSIlgcLq';
    const RZP_SECRET2 = process.env.RAZORPAY_KEY_SECRET || process.env.RAZORPAY_SECRET || '';
    if (razorpay_id && RZP_SECRET2) {
      try {
        const captureRes = await fetch(`https://api.razorpay.com/v1/payments/${razorpay_id}/capture`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Basic ' + Buffer.from(RZP_KEY2 + ':' + RZP_SECRET2).toString('base64')
          },
          body: JSON.stringify({ amount: amount * 100, currency: 'INR' })
        });
        const captureData = await captureRes.json();
        console.log(`💳 CAPTURE: ${razorpay_id} | Status: ${captureData.status}`);
      } catch (captureErr) {
        console.log('Capture note:', captureErr.message);
        // Continue even if capture fails — payment may already be captured
      }
    }
    const now = new Date();
    let subEnd = new Date(now);
    let nextDue = new Date(now);
    if (subscription_type === 'quarterly') {
      subEnd.setMonth(subEnd.getMonth() + 3);
      nextDue.setMonth(nextDue.getMonth() + 3);
    } else if (subscription_type === 'annual' || subscription_type === 'yearly') {
      subEnd.setFullYear(subEnd.getFullYear() + 1);
      nextDue.setFullYear(nextDue.getFullYear() + 1);
    } else {
      subEnd.setMonth(subEnd.getMonth() + 1);
      nextDue.setMonth(nextDue.getMonth() + 1);
    }
    await pool.query(
      `INSERT INTO bmt_payments (student_id,student_name,amount,plan,razorpay_id,status)
       VALUES ($1,$2,$3,$4,$5,'success')`,
      [student_id, student_name, amount, plan, razorpay_id]
    );
    await pool.query(
      `UPDATE bmt_students SET is_paid=true, plan=$1,
       subscription_type=$2, subscription_start=NOW(),
       subscription_end=$3, next_due_date=$4, reminder_sent=false
       WHERE id=$5`,
      [plan, subscription_type || 'monthly', subEnd, nextDue, student_id]
    );
    await pool.query(
      `INSERT INTO bmt_audit_log (student_id, student_name, action, details)
       VALUES ($1,$2,'PAYMENT',$3)`,
      [student_id, student_name, JSON.stringify({amount, plan, subscription_type, razorpay_id, sub_end: subEnd})]
    ).catch(()=>{});
    console.log(`💰 PAYMENT: ${student_name} | ₹${amount} | ${plan} | ${subscription_type||'monthly'}`);
    const daysLeft = Math.ceil((subEnd - new Date()) / (1000*60*60*24));
    res.json({ ok: true, sub_end: subEnd, expiry: subEnd, sub_expiry: subEnd, days_left: daysLeft, subscription_type: subscription_type||'monthly' });
  } catch (e) {
    console.error(e);
    res.json({ ok: false });
  }
});

// CHECK RENEWAL REMINDERS (called daily)
app.get('/api/admin/check-renewals', async (req, res) => {
  try {
    const key = req.headers['x-admin-key'];
    if (key !== process.env.ADMIN_KEY) return res.status(401).json({ ok: false });
    const threeDaysFromNow = new Date();
    threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3);
    const due = await pool.query(
      `SELECT id, name, plan, subscription_type, next_due_date
       FROM bmt_students
       WHERE is_paid=true
       AND next_due_date <= $1
       AND next_due_date >= NOW()
       AND reminder_sent=false`,
      [threeDaysFromNow]
    );
    // Mark reminder sent
    for (const s of due.rows) {
      await pool.query('UPDATE bmt_students SET reminder_sent=true WHERE id=$1', [s.id]);
    }
    res.json({ ok: true, due_students: due.rows });
  } catch (e) {
    res.json({ ok: false, due_students: [] });
  }
});

// GET STUDENT SUBSCRIPTION STATUS
app.get('/api/subscription/:id', async (req, res) => {
  try {
    const s = await pool.query(
      `SELECT is_paid, plan, subscription_type, subscription_end, next_due_date
       FROM bmt_students WHERE id=$1`, [req.params.id]
    );
    if (!s.rows.length) return res.json({ ok: false });
    const student = s.rows[0];
    const now = new Date();
    const daysLeft = student.next_due_date ?
      Math.ceil((new Date(student.next_due_date) - now) / (1000*60*60*24)) : null;
    res.json({ 
      ok: true, 
      ...student, 
      expiry: student.subscription_end,
      sub_expiry: student.subscription_end,
      days_left: daysLeft 
    });
  } catch (e) {
    res.json({ ok: false });
  }
});

// ══════════════════════════════════════════════════
// AI PROXY — Routes Anthropic calls securely
// ══════════════════════════════════════════════════
app.post('/api/ai', async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: { message: 'API key not configured' } });
    }
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
    if (data.error) console.error('Anthropic error:', data.error);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: { message: 'AI service error: ' + e.message } });
  }
});

// STREAMING AI — words appear as typed
app.post('/api/ai/stream', async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'API key not configured' });
    }
    // Set streaming headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const body = { ...req.body, stream: true };
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });

    // Pipe the stream back to client
    let fullText = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              fullText += parsed.delta.text;
              res.write(`data: ${JSON.stringify({ text: parsed.delta.text })}\n\n`);
            }
            if (parsed.type === 'message_stop') {
              res.write(`data: ${JSON.stringify({ done: true, full: fullText })}\n\n`);
            }
          } catch(e) {}
        }
      }
    }
    res.end();
  } catch (e) {
    console.error('Stream error:', e);
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
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

// SESSION END
app.post('/api/session-end', async (req, res) => {
  try {
    const { student_id, questions, subjects } = req.body;
    await pool.query(
      `UPDATE bmt_sessions SET
        logout_at = NOW(),
        duration_minutes = EXTRACT(EPOCH FROM (NOW() - login_at))/60,
        questions_in_session = $1,
        subjects_studied = $2
       WHERE student_id = $3
       AND logout_at IS NULL
       ORDER BY login_at DESC
       LIMIT 1`,
      [questions || 0, JSON.stringify(subjects || []), student_id]
    );
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false }); }
});

// ADMIN — Audit Log
app.get('/api/admin/audit', async (req, res) => {
  try {
    const key = req.headers['x-admin-key'];
    if (key !== process.env.ADMIN_KEY) return res.status(401).json({ ok: false });
    const logs = await pool.query(
      `SELECT * FROM bmt_audit_log ORDER BY created_at DESC LIMIT 200`
    );
    res.json({ ok: true, logs: logs.rows });
  } catch (e) { res.json({ ok: false, logs: [] }); }
});

// ADMIN — Sessions
app.get('/api/admin/sessions', async (req, res) => {
  try {
    const key = req.headers['x-admin-key'];
    if (key !== process.env.ADMIN_KEY) return res.status(401).json({ ok: false });
    const sessions = await pool.query(
      `SELECT s.*, 
        ROUND(COALESCE(s.duration_minutes, 
          EXTRACT(EPOCH FROM (NOW() - s.login_at))/60)::numeric, 1) as mins
       FROM bmt_sessions s
       ORDER BY s.login_at DESC LIMIT 500`
    );
    res.json({ ok: true, sessions: sessions.rows });
  } catch (e) { res.json({ ok: false, sessions: [] }); }
});

// ADMIN — Revenue Detail
app.get('/api/admin/revenue', async (req, res) => {
  try {
    const key = req.headers['x-admin-key'];
    if (key !== process.env.ADMIN_KEY) return res.status(401).json({ ok: false });
    const payments = await pool.query(
      `SELECT * FROM bmt_payments WHERE status='success' ORDER BY created_at DESC`
    );
    const total = payments.rows.reduce((s, p) => s + (p.amount || 0), 0);
    res.json({ ok: true, payments: payments.rows, total });
  } catch (e) { res.json({ ok: false, payments: [], total: 0 }); }
});

// ADMIN — Get single student for admin view
app.get('/api/admin/get-student/:id', async (req, res) => {
  try {
    const key = req.headers['x-admin-key'];
    if (key !== process.env.ADMIN_KEY) return res.status(401).json({ ok: false });
    const result = await pool.query('SELECT * FROM bmt_students WHERE id=$1', [req.params.id]);
    if (!result.rows.length) return res.json({ ok: false });
    res.json({ ok: true, student: sanitize(result.rows[0]) });
  } catch (e) {
    res.json({ ok: false });
  }
});

// ADMIN — Extend student access
app.post('/api/admin/extend-access', async (req, res) => {
  try {
    const key = req.headers['x-admin-key'];
    if (key !== process.env.ADMIN_KEY) return res.status(401).json({ ok: false });
    const { student_id, days } = req.body;
    // Get current expiry or use now
    const s = await pool.query('SELECT next_due_date, is_paid FROM bmt_students WHERE id=$1', [student_id]);
    if (!s.rows.length) return res.json({ ok: false, msg: 'Student not found' });
    const base = s.rows[0].next_due_date ? new Date(s.rows[0].next_due_date) : new Date();
    base.setDate(base.getDate() + parseInt(days));
    await pool.query(
      `UPDATE bmt_students SET 
       is_paid=true, next_due_date=$1, subscription_end=$1, reminder_sent=false
       WHERE id=$2`,
      [base, student_id]
    );
    await pool.query(`INSERT INTO bmt_audit_log (student_id, student_name, action, details) 
      SELECT id, name, 'ADMIN_EXTEND', $1 FROM bmt_students WHERE id=$2`,
      [JSON.stringify({days, new_expiry: base}), student_id]
    ).catch(()=>{});
    console.log(`⏰ ADMIN EXTENDED: ${student_id} by ${days} days until ${base}`);
    res.json({ ok: true, new_expiry: base });
  } catch (e) {
    console.error(e);
    res.json({ ok: false });
  }
});

// ADMIN — Give premium
app.post('/api/admin/give-premium', async (req, res) => {
  try {
    const key = req.headers['x-admin-key'];
    if (key !== process.env.ADMIN_KEY) return res.status(401).json({ ok: false });
    const { student_id, student_name, months, plan } = req.body;
    const expiry = new Date();
    expiry.setMonth(expiry.getMonth() + parseInt(months));
    await pool.query(
      `UPDATE bmt_students SET 
       is_paid=true, plan=$1, subscription_type='admin_gift',
       subscription_start=NOW(), subscription_end=$2, next_due_date=$2, reminder_sent=false
       WHERE id=$3`,
      [plan || 'all', expiry, student_id]
    );
    await pool.query(
      `INSERT INTO bmt_payments (student_id, student_name, amount, plan, razorpay_id, status)
       VALUES ($1, $2, 0, $3, 'admin_gift', 'success')`,
      [student_id, student_name, plan || 'all']
    ).catch(()=>{});
    await pool.query(`INSERT INTO bmt_audit_log (student_id, student_name, action, details)
      SELECT id, name, 'ADMIN_GIFT', $1 FROM bmt_students WHERE id=$2`,
      [JSON.stringify({months, plan, expiry}), student_id]
    ).catch(()=>{});
    console.log(`💎 ADMIN GIFT: ${student_name} | ${months} months`);
    res.json({ ok: true, expiry });
  } catch (e) {
    console.error(e);
    res.json({ ok: false });
  }
});

// ADMIN — Create demo account
app.post('/api/admin/create-demo', async (req, res) => {
  try {
    const key = req.headers['x-admin-key'];
    if (key !== process.env.ADMIN_KEY) return res.status(401).json({ ok: false });
    const { name, email, password, board, class: cls, state, days } = req.body;
    if (!name || !password || !cls || !state) return res.json({ ok: false, msg: 'Fill all fields!' });
    // Check name exists
    const exists = await pool.query('SELECT id FROM bmt_students WHERE LOWER(name)=LOWER($1)', [name]);
    if (exists.rows.length) return res.json({ ok: false, msg: 'Name already taken!' });
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + parseInt(days || 1));
    const result = await pool.query(
      `INSERT INTO bmt_students 
       (name, password, board, class, state, email, is_paid, plan, subscription_type, subscription_start, subscription_end, next_due_date, reg_on)
       VALUES ($1,$2,$3,$4,$5,$6,true,'all','demo_trial',NOW(),$7,$7,NOW()) RETURNING id`,
      [name, password, board || 'CBSE', cls, state, email || null, expiry]
    );
    await pool.query(
      `INSERT INTO bmt_audit_log (student_id, student_name, action, details)
       VALUES ($1,$2,'ADMIN_CREATE_DEMO',$3)`,
      [result.rows[0].id, name, JSON.stringify({days, expiry, email})]
    ).catch(()=>{});
    console.log(`🎭 DEMO CREATED: ${name} | ${days} days | expires ${expiry}`);
    res.json({ ok: true, expiry, student_id: result.rows[0].id });
  } catch (e) {
    console.error(e);
    res.json({ ok: false, msg: e.message });
  }
});

// STUDENT SUPPORT MESSAGE
app.post('/api/support', async (req, res) => {
  try {
    const { student_id, student_name, email, plan, issue_type, message } = req.body;
    await pool.query(
      `INSERT INTO bmt_support (student_id, student_name, email, plan, issue_type, message)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [student_id, student_name, email, plan, issue_type, message]
    );
    // Also log to audit
    await pool.query(
      `INSERT INTO bmt_audit_log (student_id, student_name, action, details)
       VALUES ($1,$2,'SUPPORT',$3)`,
      [student_id, student_name, JSON.stringify({issue_type, message: message.substring(0,100)})]
    ).catch(()=>{});
    console.log(`💬 SUPPORT: ${student_name} | ${issue_type} | ${message.substring(0,50)}`);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false });
  }
});

// ADMIN — Support Messages
app.get('/api/admin/support', async (req, res) => {
  try {
    const key = req.headers['x-admin-key'];
    if (key !== process.env.ADMIN_KEY) return res.status(401).json({ ok: false });
    const msgs = await pool.query(
      `SELECT * FROM bmt_support ORDER BY created_at DESC LIMIT 100`
    );
    res.json({ ok: true, messages: msgs.rows });
  } catch (e) {
    res.json({ ok: false, messages: [] });
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
