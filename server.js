const express = require("express");
const path = require("path");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const bcrypt = require("bcryptjs");
const { pool, initDb } = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function slugify(text = "") {
  return text
    .toLowerCase()
    .trim()
    .replace(/[ąćęłńóśźż]/g, (m) => ({
      ą: "a", ć: "c", ę: "e", ł: "l", ń: "n", ó: "o", ś: "s", ź: "z", ż: "z"
    }[m] || m))
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildEmptyState(companyName = "RentFlow") {
  return {
    buildings: [],
    units: [],
    tenants: [],
    leases: [],
    meters: [],
    meterReadings: [],
    charges: [],
    payments: [],
    expenses: [],
    tickets: [],
    settlements: [],
    settings: {
      companyName,
      ownerName: "",
      baseCurrency: "PLN",
      utilityVAT: 23,
      lateFee: 50,
      bankAccount: "",
      paymentDueDay: 10
    }
  };
}

app.use(express.json({ limit: "10mb" }));

app.use(
  session({
    store: new pgSession({
      pool,
      tableName: "user_sessions",
      createTableIfMissing: true
    }),
    secret: process.env.SESSION_SECRET || "change-me-now",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: 1000 * 60 * 60 * 24 * 14
    }
  })
);

app.use(express.static(path.join(__dirname, "public")));

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: "Brak autoryzacji" });
  }
  next();
}

app.post("/api/register", async (req, res) => {
  try {
    const { companyName, name, email, password } = req.body;

    if (!companyName || !name || !email || !password) {
      return res.status(400).json({ error: "Brak wymaganych pól" });
    }

    const existing = await pool.query(
      "SELECT id FROM users WHERE email = $1 LIMIT 1",
      [email.toLowerCase()]
    );

    if (existing.rows.length) {
      return res.status(400).json({ error: "Użytkownik już istnieje" });
    }

    const orgId = uid("org");
    const userId = uid("usr");
    const slug = `${slugify(companyName)}-${Math.random().toString(36).slice(2, 6)}`;
    const passwordHash = await bcrypt.hash(password, 10);

    await pool.query("BEGIN");

    await pool.query(
      "INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)",
      [orgId, companyName, slug]
    );

    await pool.query(
      "INSERT INTO users (id, org_id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, $5, $6)",
      [userId, orgId, name, email.toLowerCase(), passwordHash, "owner"]
    );

    await pool.query(
      "INSERT INTO app_states (org_id, state) VALUES ($1, $2::jsonb)",
      [orgId, JSON.stringify(buildEmptyState(companyName))]
    );

    await pool.query("COMMIT");

    req.session.user = {
      id: userId,
      orgId,
      email: email.toLowerCase(),
      name,
      role: "owner",
      companyName
    };

    res.json({ ok: true });
  } catch (error) {
    try {
      await pool.query("ROLLBACK");
    } catch (_) {}
    console.error(error);
    res.status(500).json({ error: "Nie udało się utworzyć konta" });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const result = await pool.query(
      `
      SELECT u.id, u.org_id, u.name, u.email, u.password_hash, u.role, o.name AS company_name
      FROM users u
      JOIN organizations o ON o.id = u.org_id
      WHERE u.email = $1
      LIMIT 1
      `,
      [String(email || "").toLowerCase()]
    );

    if (!result.rows.length) {
      return res.status(401).json({ error: "Nieprawidłowy login lub hasło" });
    }

    const user = result.rows[0];
    const ok = await bcrypt.compare(password || "", user.password_hash);

    if (!ok) {
      return res.status(401).json({ error: "Nieprawidłowy login lub hasło" });
    }

    req.session.user = {
      id: user.id,
      orgId: user.org_id,
      email: user.email,
      name: user.name,
      role: user.role,
      companyName: user.company_name
    };

    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Błąd logowania" });
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get("/api/me", (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: "Brak sesji" });
  }
  res.json(req.session.user);
});

app.get("/api/state", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT state FROM app_states WHERE org_id = $1 LIMIT 1",
      [req.session.user.orgId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Brak danych organizacji" });
    }

    const state = result.rows[0].state || {};

    state.buildings ||= [];
    state.units ||= [];
    state.tenants ||= [];
    state.leases ||= [];
    state.meters ||= [];
    state.meterReadings ||= [];
    state.charges ||= [];
    state.payments ||= [];
    state.expenses ||= [];
    state.tickets ||= [];
    state.settlements ||= [];
    state.settings ||= {};
    state.settings.companyName ||= req.session.user.companyName || "RentFlow";
    state.settings.ownerName ||= "";
    state.settings.baseCurrency ||= "PLN";
    state.settings.utilityVAT ||= 23;
    state.settings.lateFee ||= 50;
    state.settings.bankAccount ||= "";
    state.settings.paymentDueDay ||= 10;

    res.json(state);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Nie udało się pobrać danych" });
  }
});

app.post("/api/state", requireAuth, async (req, res) => {
  try {
    const state = req.body || {};
    state.buildings ||= [];
    state.units ||= [];
    state.tenants ||= [];
    state.leases ||= [];
    state.meters ||= [];
    state.meterReadings ||= [];
    state.charges ||= [];
    state.payments ||= [];
    state.expenses ||= [];
    state.tickets ||= [];
    state.settlements ||= [];
    state.settings ||= {};
    state.settings.companyName ||= req.session.user.companyName || "RentFlow";
    state.settings.ownerName ||= "";
    state.settings.baseCurrency ||= "PLN";
    state.settings.utilityVAT ||= 23;
    state.settings.lateFee ||= 50;
    state.settings.bankAccount ||= "";
    state.settings.paymentDueDay ||= 10;

    await pool.query(
      "UPDATE app_states SET state = $1::jsonb, updated_at = NOW() WHERE org_id = $2",
      [JSON.stringify(state), req.session.user.orgId]
    );
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Nie udało się zapisać danych" });
  }
});

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

(async () => {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`RentFlow V4 działa na porcie ${PORT}`);
    });
  } catch (error) {
    console.error("Błąd startu aplikacji:", error);
    process.exit(1);
  }
})();