const crypto = require("crypto");
const express = require("express");
const path = require("path");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const bcrypt = require("bcryptjs");
const { pool, initDb } = require("./db");
const { buildEmptyState, normalizeState, sanitizeText } = require("./lib/state");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const SESSION_COOKIE_NAME = "rentflow.sid";
const SESSION_SECRET = process.env.SESSION_SECRET || "local-dev-only-change-me";

if (IS_PRODUCTION && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 24)) {
  throw new Error("SESSION_SECRET musi być ustawiony i mieć co najmniej 24 znaki w produkcji.");
}

function uid(prefix = "id") {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function slugify(text = "") {
  return text
    .toLowerCase()
    .trim()
    .replace(/[ąćęłńóśźż]/g, (match) => ({
      ą: "a", ć: "c", ę: "e", ł: "l", ń: "n", ó: "o", ś: "s", ź: "z", ż: "z"
    }[match] || match))
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function ensureRequiredText(value, fieldName, minLength = 1) {
  const sanitized = sanitizeText(value || "");
  if (sanitized.length < minLength) {
    return { error: `${fieldName} jest wymagane.` };
  }

  return { value: sanitized };
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function destroySession(req) {
  return new Promise((resolve, reject) => {
    req.session.destroy((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function setAuthenticatedUser(req, user) {
  req.session.user = {
    id: user.id,
    orgId: user.orgId,
    email: user.email,
    name: user.name,
    role: user.role,
    companyName: user.companyName
  };
}

async function createOrganizationWithOwner({ companyName, name, email, password }) {
  const client = await pool.connect();

  try {
    const existing = await client.query(
      "SELECT id FROM users WHERE email = $1 LIMIT 1",
      [email]
    );

    if (existing.rows.length) {
      return { error: "Użytkownik już istnieje." };
    }

    const orgId = uid("org");
    const userId = uid("usr");
    const slugBase = slugify(companyName) || "rentflow";
    const slug = `${slugBase}-${crypto.randomUUID().slice(0, 6)}`;
    const passwordHash = await bcrypt.hash(password, 12);

    await client.query("BEGIN");
    await client.query(
      "INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)",
      [orgId, companyName, slug]
    );
    await client.query(
      "INSERT INTO users (id, org_id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, $5, $6)",
      [userId, orgId, name, email, passwordHash, "owner"]
    );
    await client.query(
      "INSERT INTO app_states (org_id, state) VALUES ($1, $2::jsonb)",
      [orgId, JSON.stringify(buildEmptyState(companyName))]
    );
    await client.query("COMMIT");

    return {
      user: {
        id: userId,
        orgId,
        email,
        name,
        role: "owner",
        companyName
      }
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

if (IS_PRODUCTION) {
  app.set("trust proxy", 1);
}

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  next();
});

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false, limit: "100kb" }));
app.use(
  session({
    name: SESSION_COOKIE_NAME,
    store: new pgSession({
      pool,
      tableName: "user_sessions",
      createTableIfMissing: true
    }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    unset: "destroy",
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: IS_PRODUCTION,
      maxAge: 1000 * 60 * 60 * 24 * 14
    }
  })
);

app.use(express.static(path.join(__dirname, "public")));

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: "Brak autoryzacji." });
  }

  return next();
}

app.post("/api/register", async (req, res) => {
  try {
    const companyNameResult = ensureRequiredText(req.body.companyName, "Nazwa firmy");
    const nameResult = ensureRequiredText(req.body.name, "Imię i nazwisko");
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (companyNameResult.error || nameResult.error || !email || !password) {
      return res.status(400).json({ error: "Wypełnij wszystkie wymagane pola." });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Podaj poprawny adres e-mail." });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: "Hasło musi mieć co najmniej 8 znaków." });
    }

    const result = await createOrganizationWithOwner({
      companyName: companyNameResult.value,
      name: nameResult.value,
      email,
      password
    });

    if (result.error) {
      return res.status(400).json({ error: result.error });
    }

    await regenerateSession(req);
    setAuthenticatedUser(req, result.user);

    return res.json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Nie udało się utworzyć konta." });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (!email || !password) {
      return res.status(400).json({ error: "Podaj e-mail i hasło." });
    }

    const result = await pool.query(
      `
      SELECT u.id, u.org_id, u.name, u.email, u.password_hash, u.role, o.name AS company_name
      FROM users u
      JOIN organizations o ON o.id = u.org_id
      WHERE u.email = $1
      LIMIT 1
      `,
      [email]
    );

    if (!result.rows.length) {
      return res.status(401).json({ error: "Nieprawidłowy login lub hasło." });
    }

    const user = result.rows[0];
    const passwordValid = await bcrypt.compare(password, user.password_hash);

    if (!passwordValid) {
      return res.status(401).json({ error: "Nieprawidłowy login lub hasło." });
    }

    await regenerateSession(req);
    setAuthenticatedUser(req, {
      id: user.id,
      orgId: user.org_id,
      email: user.email,
      name: sanitizeText(user.name),
      role: user.role,
      companyName: sanitizeText(user.company_name)
    });

    return res.json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Błąd logowania." });
  }
});

app.post("/api/logout", async (req, res) => {
  try {
    await destroySession(req);
    res.clearCookie(SESSION_COOKIE_NAME);
    return res.json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Nie udało się wylogować." });
  }
});

app.get("/api/me", (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: "Brak sesji." });
  }

  return res.json(req.session.user);
});

app.get("/api/state", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT state FROM app_states WHERE org_id = $1 LIMIT 1",
      [req.session.user.orgId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Brak danych organizacji." });
    }

    const state = normalizeState(result.rows[0].state, req.session.user.companyName);
    return res.json(state);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Nie udało się pobrać danych." });
  }
});

app.post("/api/state", requireAuth, async (req, res) => {
  try {
    const state = normalizeState(req.body, req.session.user.companyName);

    await pool.query(
      "UPDATE app_states SET state = $1::jsonb, updated_at = NOW() WHERE org_id = $2",
      [JSON.stringify(state), req.session.user.orgId]
    );

    return res.json({ ok: true, savedAt: new Date().toISOString() });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Nie udało się zapisać danych." });
  }
});

app.get("/login", (req, res) => {
  if (req.session.user) {
    return res.redirect("/");
  }

  return res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/", (req, res) => {
  if (!req.session.user) {
    return res.redirect("/login");
  }

  return res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("*", (req, res) => {
  if (!req.session.user) {
    return res.redirect("/login");
  }

  return res.sendFile(path.join(__dirname, "public", "index.html"));
});

(async () => {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`RentFlow działa na porcie ${PORT}`);
    });
  } catch (error) {
    console.error("Błąd startu aplikacji:", error);
    process.exit(1);
  }
})();
