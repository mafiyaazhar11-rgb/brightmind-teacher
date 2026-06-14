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

    -- QUESTION BANK TABLE
    CREATE TABLE IF NOT EXISTS bmt_question_bank (
      id BIGSERIAL PRIMARY KEY,
      board VARCHAR(20) NOT NULL,
      class VARCHAR(5) NOT NULL,
      subject VARCHAR(100) NOT NULL,
      chapter VARCHAR(200),
      topic VARCHAR(200),
      question TEXT NOT NULL,
      option_a TEXT NOT NULL,
      option_b TEXT NOT NULL,
      option_c TEXT NOT NULL,
      option_d TEXT NOT NULL,
      correct_answer VARCHAR(1) NOT NULL,
      explanation TEXT,
      difficulty VARCHAR(10) DEFAULT 'medium',
      marks INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT NOW(),
      created_by VARCHAR(50) DEFAULT 'admin'
    );
    CREATE INDEX IF NOT EXISTS idx_qbank_lookup ON bmt_question_bank(board, class, subject);
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
    daily_q_limit: s.plan === 'premium' ? 75 : s.plan === 'all' ? 45 : s.daily_q_limit || 3,
    daily_photo_limit: s.plan === 'premium' ? 5 : s.plan === 'all' ? 2 : 0,
    questions_today_photo: s.questions_today_photo || 0,
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
    // Set limits based on plan
    const qLimit = plan === 'premium' ? 75 : 45; // premium=75, basic=45
    const photoLimit = plan === 'premium' ? 5 : 2;
    await pool.query(
      `UPDATE bmt_students SET is_paid=true, plan=$1,
       subscription_type=$2, subscription_start=NOW(),
       subscription_end=$3, next_due_date=$4, reminder_sent=false,
       daily_q_limit=$5, daily_photo_limit=$6
       WHERE id=$7`,
      [plan, subscription_type || 'monthly', subEnd, nextDue, qLimit, photoLimit, student_id]
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

// ── EMERGENCY: Manually activate premium for a student by name or phone ──
app.post('/api/admin/activate-student', async (req, res) => {
  try {
    const key = req.headers['x-admin-key'];
    if (key !== (process.env.ADMIN_KEY || 'azhar2026')) return res.status(401).json({ ok: false, msg: 'Unauthorized' });
    const { student_id, student_name, months, subscription_type } = req.body;
    if (!student_id && !student_name) return res.json({ ok: false, msg: 'Need student_id or student_name' });

    const expiry = new Date();
    const m = parseInt(months) || 1;
    expiry.setMonth(expiry.getMonth() + m);
    const demoQLimit = parseInt(req.body.q_limit) || 10;
    const demoPhotoLimit = parseInt(req.body.photo_limit) || 1;

    let query, params;
    if (student_id) {
      query = `UPDATE bmt_students SET is_paid=true, plan='demo', subscription_type=$1,
               subscription_start=NOW(), subscription_end=$2, next_due_date=$2, reminder_sent=false,
               daily_q_limit=$3, daily_photo_limit=$4
               WHERE id=$5 RETURNING id, name, is_paid, subscription_end`;
      params = [subscription_type || 'monthly', expiry, demoQLimit, demoPhotoLimit, student_id];
    } else {
      query = `UPDATE bmt_students SET is_paid=true, plan='all', subscription_type=$1,
               subscription_start=NOW(), subscription_end=$2, next_due_date=$2, reminder_sent=false
               WHERE LOWER(name) LIKE LOWER($3) RETURNING id, name, is_paid, subscription_end`;
      params = [subscription_type || 'monthly', expiry, '%' + student_name + '%'];
    }
    const result = await pool.query(query, params);
    if (!result.rows.length) return res.json({ ok: false, msg: 'Student not found' });
    const s = result.rows[0];
    await pool.query(
      `INSERT INTO bmt_audit_log (student_id, student_name, action, details) VALUES ($1,$2,'ADMIN_ACTIVATE',$3)`,
      [s.id, s.name, JSON.stringify({ months: m, expiry, by: 'admin' })]
    ).catch(() => {});
    console.log(`🔧 ADMIN ACTIVATE: ${s.name} | ${m} month(s) | expires ${expiry}`);
    res.json({ ok: true, student: s.name, id: s.id, is_paid: true, expiry, days: m * 30 });
  } catch (e) {
    console.error(e);
    res.json({ ok: false, msg: e.message });
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

// FIND STUDENT BY NAME (admin use)
app.get('/api/admin/find-student', async (req, res) => {
  try {
    const key = req.headers['x-admin-key'];
    if (key !== (process.env.ADMIN_KEY || 'azhar2026')) return res.status(401).json({ ok: false });
    const name = req.query.name || '';
    const result = await pool.query(
      `SELECT id, name, is_paid, plan, subscription_type, subscription_end, reg_on
       FROM bmt_students WHERE LOWER(name) LIKE LOWER($1) ORDER BY reg_on DESC LIMIT 10`,
      ['%' + name + '%']
    );
    res.json({ ok: true, students: result.rows });
  } catch (e) {
    res.json({ ok: false });
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
// ══════════════════════════════════════
// QUESTION BANK — serve from DB, zero AI cost per exam
// ══════════════════════════════════════

// GET random questions for student exam from bank
app.get('/api/qbank/exam', async (req, res) => {
  try {
    const { board, class: cls, subject, count = 15 } = req.query;
    if (!board || !cls || !subject) return res.json({ ok: false, msg: 'Missing params' });
    const result = await pool.query(
      `SELECT question, option_a, option_b, option_c, option_d, correct_answer, explanation, marks
       FROM bmt_question_bank
       WHERE board=$1 AND class=$2 AND LOWER(subject) LIKE LOWER($3)
       ORDER BY RANDOM() LIMIT $4`,
      [board, cls, `%${subject}%`, parseInt(count)]
    );
    if (result.rows.length < 8) return res.json({ ok: false, msg: 'no_questions' });
    const questions = result.rows.map(q => ({
      q: q.question,
      options: ['A) '+q.option_a,'B) '+q.option_b,'C) '+q.option_c,'D) '+q.option_d],
      correct: q.correct_answer,
      explanation: q.explanation || '',
      marks: q.marks || 1
    }));
    res.json({ ok: true, questions });
  } catch(e) { res.json({ ok: false, msg: e.message }); }
});

// GET question bank stats (admin)
app.get('/api/admin/qbank/stats', async (req, res) => {
  try {
    const key = req.headers['x-admin-key'];
    if (key !== (process.env.ADMIN_KEY || 'azhar2026')) return res.status(401).json({ ok: false });
    const result = await pool.query(
      `SELECT board, class, subject, COUNT(*) as count FROM bmt_question_bank GROUP BY board, class, subject ORDER BY board, class, subject`
    );
    const total = await pool.query('SELECT COUNT(*) FROM bmt_question_bank');
    res.json({ ok: true, breakdown: result.rows, total: parseInt(total.rows[0].count) });
  } catch(e) { res.json({ ok: false, msg: e.message }); }
});

// POST bulk generate questions — admin calls AI ONCE, saves forever
app.post('/api/admin/qbank/generate', async (req, res) => {
  try {
    const key = req.headers['x-admin-key'];
    if (key !== (process.env.ADMIN_KEY || 'azhar2026')) return res.status(401).json({ ok: false });
    const { board, class: cls, subject, chapter, topic, count = 50 } = req.body;
    if (!board || !cls || !subject) return res.status(400).json({ ok: false, msg: 'Missing params' });
    const boardFull = {CBSE:'CBSE',TN:'Tamil Nadu State Board',KL:'Kerala Board',KA:'Karnataka Board',AP:'AP Board',TS:'Telangana Board'}[board]||board;
    const prompt = `Generate EXACTLY ${count} MCQ questions for ${boardFull} Class ${cls} ${subject}${chapter?' Chapter: '+chapter:''}${topic?' Topic: '+topic:''}.
Rules: Real syllabus content. 4 realistic options each. Correct answers mixed (A/B/C/D varied). Include easy(30%)/medium(40%)/hard(30%).
Return ONLY valid JSON array:
[{"q":"question","a":"optionA","b":"optionB","c":"optionC","d":"optionD","correct":"B","explanation":"why","difficulty":"medium","chapter":"chap name"}]`;
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},
      body: JSON.stringify({ model:'claude-sonnet-4-6', max_tokens:4000, messages:[{role:'user',content:prompt}] })
    });
    const aiData = await aiRes.json();
    if (aiData.error) return res.json({ ok:false, msg:aiData.error.message });
    let raw = (aiData.content?.[0]?.text||'[]').replace(/```json|```/g,'').trim();
    let questions;
    try { questions = JSON.parse(raw); } catch(e) { return res.json({ ok:false, msg:'Invalid JSON from AI', raw:raw.substring(0,300) }); }
    if (!Array.isArray(questions)||!questions.length) return res.json({ ok:false, msg:'No questions returned' });
    let saved = 0;
    for (const q of questions) {
      if (!q.q||!q.a||!q.correct) continue;
      try {
        await pool.query(
          `INSERT INTO bmt_question_bank (board,class,subject,chapter,topic,question,option_a,option_b,option_c,option_d,correct_answer,explanation,difficulty)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [board,cls,subject,q.chapter||chapter||'',topic||'',q.q,q.a,q.b||'',q.c||'',q.d||'',
           (q.correct||'A').toUpperCase().charAt(0),q.explanation||'',q.difficulty||'medium']
        );
        saved++;
      } catch(e) { /* skip duplicates */ }
    }
    res.json({ ok:true, generated:questions.length, saved, board, class:cls, subject });
  } catch(e) { res.json({ ok:false, msg:e.message }); }
});

// AUTO BULK GENERATE — one API call generates ALL subjects for a board
app.post('/api/admin/qbank/auto-bulk', async (req, res) => {
  try {
    const key = req.headers['x-admin-key'];
    if (key !== (process.env.ADMIN_KEY || 'azhar2026')) return res.status(401).json({ ok: false });

    const { board } = req.body;
    if (!board) return res.status(400).json({ ok: false, msg: 'Board required' });

    // Full syllabus map
    const SYLLABUS = {
      TN: {
        '9':  ['Tamil','English','Mathematics','Science','Social Science'],
        '10': ['Tamil','English','Mathematics','Science','Social Science'],
        '11': ['Tamil','English','Mathematics','Physics','Chemistry','Biology','Commerce','Economics','Accountancy','History','Geography'],
        '12': ['Tamil','English','Mathematics','Physics','Chemistry','Biology','Commerce','Economics','Accountancy','History','Geography']
      },
      CBSE: {
        '9':  ['English','Mathematics','Science','Social Science','Hindi'],
        '10': ['English','Mathematics','Science','Social Science','Hindi'],
        '11': ['English','Mathematics','Physics','Chemistry','Biology','Accountancy','Business Studies','Economics','History','Geography'],
        '12': ['English','Mathematics','Physics','Chemistry','Biology','Accountancy','Business Studies','Economics','History','Geography']
      },
      KL: {
        '9':  ['Malayalam','English','Mathematics','Physics','Chemistry','Biology','Social Science'],
        '10': ['Malayalam','English','Mathematics','Physics','Chemistry','Biology','Social Science'],
        '11': ['English','Mathematics','Physics','Chemistry','Biology','Commerce','Economics','History'],
        '12': ['English','Mathematics','Physics','Chemistry','Biology','Commerce','Economics','History']
      },
      KA: {
        '9':  ['Kannada','English','Mathematics','Science','Social Science'],
        '10': ['Kannada','English','Mathematics','Science','Social Science'],
        '11': ['English','Mathematics','Physics','Chemistry','Biology','Commerce','Economics','History'],
        '12': ['English','Mathematics','Physics','Chemistry','Biology','Commerce','Economics','History']
      },
      AP: {
        '9':  ['Telugu','English','Mathematics','Physical Science','Biological Science','Social Studies'],
        '10': ['Telugu','English','Mathematics','Physical Science','Biological Science','Social Studies'],
        '11': ['English','Mathematics','Physics','Chemistry','Biology','Commerce','Economics','History'],
        '12': ['English','Mathematics','Physics','Chemistry','Biology','Commerce','Economics','History']
      },
      TS: {
        '9':  ['Telugu','English','Mathematics','Physical Science','Biological Science','Social Studies'],
        '10': ['Telugu','English','Mathematics','Physical Science','Biological Science','Social Studies'],
        '11': ['English','Mathematics','Physics','Chemistry','Biology','Commerce','Economics','History'],
        '12': ['English','Mathematics','Physics','Chemistry','Biology','Commerce','Economics','History']
      },
      MH: {
        '9':  ['Marathi','English','Mathematics','Science','Social Science'],
        '10': ['Marathi','English','Mathematics','Science','Social Science'],
        '11': ['English','Mathematics','Physics','Chemistry','Biology','Commerce','Economics','History','Geography'],
        '12': ['English','Mathematics','Physics','Chemistry','Biology','Commerce','Economics','History','Geography']
      },
      UP: {
        '9':  ['Hindi','English','Mathematics','Science','Social Science'],
        '10': ['Hindi','English','Mathematics','Science','Social Science'],
        '11': ['Hindi','English','Mathematics','Physics','Chemistry','Biology','Commerce','Economics','History'],
        '12': ['Hindi','English','Mathematics','Physics','Chemistry','Biology','Commerce','Economics','History']
      },
      WB: {
        '9':  ['Bengali','English','Mathematics','Physical Science','Life Science','Geography','History'],
        '10': ['Bengali','English','Mathematics','Physical Science','Life Science','Geography','History'],
        '11': ['English','Mathematics','Physics','Chemistry','Biology','Commerce','Economics','History','Geography'],
        '12': ['English','Mathematics','Physics','Chemistry','Biology','Commerce','Economics','History','Geography']
      },
      GJ: {
        '9':  ['Gujarati','English','Mathematics','Science','Social Science'],
        '10': ['Gujarati','English','Mathematics','Science','Social Science'],
        '11': ['English','Mathematics','Physics','Chemistry','Biology','Commerce','Economics','History'],
        '12': ['English','Mathematics','Physics','Chemistry','Biology','Commerce','Economics','History']
      },
      RJ: {
        '9':  ['Hindi','English','Mathematics','Science','Social Science'],
        '10': ['Hindi','English','Mathematics','Science','Social Science'],
        '11': ['English','Mathematics','Physics','Chemistry','Biology','Commerce','Economics','History'],
        '12': ['English','Mathematics','Physics','Chemistry','Biology','Commerce','Economics','History']
      }
    };

    const boardMap = {
      TN:'Tamil Nadu State Board', CBSE:'CBSE',
      KL:'Kerala Board (SCERT)', KA:'Karnataka State Board (KSEEB)',
      AP:'Andhra Pradesh State Board', TS:'Telangana State Board',
      MH:'Maharashtra State Board', UP:'Uttar Pradesh State Board (UPMSP)',
      WB:'West Bengal Board (WBBSE)', GJ:'Gujarat State Board (GSEB)',
      RJ:'Rajasthan State Board (RBSE)'
    };
    const boardFull = boardMap[board] || board;
    const classes = SYLLABUS[board];
    if (!classes) return res.json({ ok: false, msg: 'Board not in syllabus map' });

    // Send back immediately — process in background
    res.json({ ok: true, msg: 'Bulk generation started in background', board, boardFull });

    // Background processing — generate all subjects sequentially
    (async () => {
      let totalSaved = 0;
      let errors = [];
      const allCombos = [];
      for (const [cls, subjects] of Object.entries(classes)) {
        for (const subject of subjects) {
          allCombos.push({ cls, subject });
        }
      }
      console.log(`🚀 Auto-bulk started: ${board} — ${allCombos.length} subject-class combos`);

      for (const { cls, subject } of allCombos) {
        try {
          // Check if already has 20+ questions
          const existing = await pool.query(
            'SELECT COUNT(*) FROM bmt_question_bank WHERE board=$1 AND class=$2 AND LOWER(subject)=LOWER($3)',
            [board, cls, subject]
          );
          if (parseInt(existing.rows[0].count) >= 20) {
            console.log(`⏭️ Skip ${board} Cl${cls} ${subject} — already has ${existing.rows[0].count} questions`);
            continue;
          }

          const prompt = `[{"q":"What is photosynthesis?","a":"Process of making food","b":"Process of breathing","c":"Process of digestion","d":"Process of reproduction","correct":"A","explanation":"Plants make food using sunlight","difficulty":"easy","chapter":"Life Processes"},{"q":"example2","a":"opt1","b":"opt2","c":"opt3","d":"opt4","correct":"B","explanation":"reason","difficulty":"medium","chapter":"chapter"}]

Above is the EXACT JSON format. Now generate 30 MCQ questions for ${boardFull} Class ${cls} ${subject}.
STRICT RULES:
- Output ONLY the JSON array starting with [ and ending with ]
- NO explanation text before or after
- NO markdown, NO backticks, NO \`\`\`json
- Each object must have: q, a, b, c, d, correct, explanation, difficulty, chapter
- correct must be exactly: A or B or C or D
- Mix correct answers: use A, B, C, D in rotation

Start with [ now:`;

          const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01' },
            body: JSON.stringify({ model:'claude-sonnet-4-6', max_tokens:4000, messages:[{role:'user',content:prompt}] })
          });

          const aiData = await aiRes.json();
          if (aiData.error) { errors.push(`${cls} ${subject}: ${aiData.error.message}`); continue; }

          let raw = (aiData.content?.[0]?.text||'[]');
          // Aggressive cleanup — extract just the JSON array
          raw = raw.replace(/```json/g,'').replace(/```/g,'').trim();
          // Find the JSON array boundaries
          const startIdx = raw.indexOf('[');
          const endIdx = raw.lastIndexOf(']');
          if (startIdx === -1 || endIdx === -1) {
            errors.push(`${cls} ${subject}: no JSON array found`);
            console.error(`❌ ${cls} ${subject} raw:`, raw.substring(0,200));
            continue;
          }
          raw = raw.substring(startIdx, endIdx + 1);
          let questions;
          try { 
            questions = JSON.parse(raw); 
          } catch(e) { 
            // Try fixing common JSON issues
            try {
              raw = raw.replace(/,\s*]/g,']').replace(/,\s*}/g,'}');
              questions = JSON.parse(raw);
            } catch(e2) {
              errors.push(`${cls} ${subject}: parse error - ${e2.message}`);
              console.error(`❌ ${cls} ${subject} parse fail:`, raw.substring(0,300));
              continue;
            }
          }
          if (!Array.isArray(questions)||!questions.length) {
            errors.push(`${cls} ${subject}: empty array`);
            continue;
          }

          let saved = 0;
          for (const q of questions) {
            if (!q.q||!q.a||!q.correct) continue;
            try {
              await pool.query(
                `INSERT INTO bmt_question_bank (board,class,subject,chapter,question,option_a,option_b,option_c,option_d,correct_answer,explanation,difficulty)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
                [board,cls,subject,q.chapter||'',q.q,q.a,q.b||'-',q.c||'-',q.d||'-',
                 (q.correct||'A').toUpperCase().charAt(0),q.explanation||'',q.difficulty||'medium']
              );
              saved++;
            } catch(e) { /* skip */ }
          }
          totalSaved += saved;
          console.log(`✅ ${board} Cl${cls} ${subject}: ${saved} saved`);

          // Rate limit — wait 1s between calls to avoid hitting API limits
          await new Promise(r => setTimeout(r, 1200));

        } catch(e) {
          errors.push(`${cls} ${subject}: ${e.message}`);
          console.error(`❌ ${cls} ${subject}:`, e.message);
        }
      }
      console.log(`🎉 Auto-bulk complete: ${totalSaved} total questions saved. Errors: ${errors.length}`);
      if (errors.length) console.log('Errors:', errors);
    })();

  } catch(e) {
    console.error('Auto-bulk error:', e.message);
    res.json({ ok: false, msg: e.message });
  }
});

// GET bulk generation status
app.get('/api/admin/qbank/status', async (req, res) => {
  try {
    const key = req.headers['x-admin-key'];
    if (key !== (process.env.ADMIN_KEY || 'azhar2026')) return res.status(401).json({ ok: false });
    const board = req.query.board;
    const result = await pool.query(
      `SELECT class, subject, COUNT(*) as count FROM bmt_question_bank
       WHERE ($1::text IS NULL OR board=$1)
       GROUP BY class, subject ORDER BY class, subject`,
      [board || null]
    );
    const total = await pool.query(
      `SELECT COUNT(*) FROM bmt_question_bank WHERE ($1::text IS NULL OR board=$1)`,
      [board || null]
    );
    res.json({ ok: true, breakdown: result.rows, total: parseInt(total.rows[0].count) });
  } catch(e) { res.json({ ok: false, msg: e.message }); }
});

// DELETE questions (admin)
app.delete('/api/admin/qbank/clear', async (req, res) => {
  try {
    const key = req.headers['x-admin-key'];
    if (key !== (process.env.ADMIN_KEY || 'azhar2026')) return res.status(401).json({ ok:false });
    const { board, class: cls, subject } = req.body;
    let q = 'DELETE FROM bmt_question_bank WHERE 1=1'; const params = [];
    if (board) { params.push(board); q+=` AND board=$${params.length}`; }
    if (cls) { params.push(cls); q+=` AND class=$${params.length}`; }
    if (subject) { params.push(`%${subject}%`); q+=` AND LOWER(subject) LIKE LOWER($${params.length})`; }
    const r = await pool.query(q, params);
    res.json({ ok:true, deleted:r.rowCount });
  } catch(e) { res.json({ ok:false, msg:e.message }); }
});

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
    if (data.error) {
      console.error('Anthropic error:', data.error.type, data.error.message);
      // Never forward raw billing/credit errors to students
      const errType = (data.error.type || '').toLowerCase();
      const errMsg = (data.error.message || '').toLowerCase();
      if (errType.includes('credit') || errType.includes('billing') || 
          errType.includes('quota') || errMsg.includes('credit') || errMsg.includes('billing')) {
        // Alert owner via console but show friendly message to student
        console.error('🚨 BILLING ALERT: Anthropic credits low or exhausted! Top up at console.anthropic.com');
        return res.json({ content: [{ type: 'text', text: 'Miss BrightMind is taking a short break! Please try again in a few minutes. 😊' }] });
      }
      // Other errors — still friendly
      return res.json({ content: [{ type: 'text', text: 'I could not answer that right now. Please ask your question again! 😊' }] });
    }
    res.json(data);
  } catch (e) {
    console.error('AI proxy error:', e.message);
    res.status(500).json({ content: [{ type: 'text', text: 'Miss BrightMind is taking a short break! Please try again. 😊' }] });
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
// HIGH USAGE AUDIT — admin sees who is using most
app.get('/api/admin/usage-audit', async (req, res) => {
  try {
    const key = req.headers['x-admin-key'];
    if (key !== (process.env.ADMIN_KEY || 'azhar2026')) return res.status(401).json({ ok: false });
    const result = await pool.query(`
      SELECT id, name, plan, is_paid,
             questions_today, daily_q_limit,
             questions_today_photo, daily_photo_limit,
             total_questions, total_api_calls,
             ROUND((questions_today::numeric / NULLIF(daily_q_limit,0)) * 100) as q_usage_pct,
             last_login_date, reg_on
      FROM bmt_students
      ORDER BY questions_today DESC, total_api_calls DESC
      LIMIT 50
    `);
    res.json({ ok: true, students: result.rows });
  } catch(e) {
    res.json({ ok: false, msg: e.message });
  }
});

// LOG AI USAGE per call
app.post('/api/log-usage', async (req, res) => {
  try {
    const { student_id, type } = req.body; // type: 'question' or 'photo'
    if (!student_id) return res.json({ ok: false });
    if (type === 'photo') {
      await pool.query(
        `UPDATE bmt_students SET 
         questions_today_photo = CASE WHEN last_photo_date = CURRENT_DATE THEN questions_today_photo+1 ELSE 1 END,
         last_photo_date = CURRENT_DATE,
         total_api_calls = total_api_calls + 1
         WHERE id=$1`, [student_id]
      );
    } else {
      await pool.query(
        `UPDATE bmt_students SET total_api_calls = total_api_calls + 1 WHERE id=$1`,
        [student_id]
      );
    }
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false }); }
});

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
