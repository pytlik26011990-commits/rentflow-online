const crypto = require("crypto");
const express = require("express");
const path = require("path");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const bcrypt = require("bcryptjs");
const { pool, initDb } = require("./db");
const { buildEmptyState, buildTenantState, normalizeState, sanitizeText } = require("./lib/state");

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
    companyName: user.companyName,
    tenantId: user.tenantId || null
  };
}

async function getOrganizationState(orgId, companyName) {
  const result = await pool.query(
    "SELECT state FROM app_states WHERE org_id = $1 LIMIT 1",
    [orgId]
  );

  if (!result.rows.length) {
    return null;
  }

  return normalizeState(result.rows[0].state, companyName);
}

async function saveOrganizationState(orgId, companyName, state) {
  const nextState = normalizeState(state, companyName);
  await pool.query(
    "UPDATE app_states SET state = $1::jsonb, updated_at = NOW() WHERE org_id = $2",
    [JSON.stringify(nextState), orgId]
  );
  return nextState;
}

function canAccessTicket(user, ticket, state) {
  if (!user || !ticket) return false;
  if (user.role === "owner") return true;
  if (user.role !== "tenant" || !user.tenantId) return false;
  if (ticket.tenantId === user.tenantId) return true;
  const tenantState = buildTenantState(state, user.tenantId);
  return tenantState.tickets.some((entry) => entry.id === ticket.id);
}

function requireOwner(req, res, next) {
  if (!req.session.user || req.session.user.role !== "owner") {
    return res.status(403).json({ error: "Ta operacja jest dostępna tylko dla właściciela." });
  }

  return next();
}

function requireTenant(req, res, next) {
  if (!req.session.user || req.session.user.role !== "tenant" || !req.session.user.tenantId) {
    return res.status(403).json({ error: "Ta operacja jest dostępna tylko dla najemcy." });
  }

  return next();
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

app.use(express.json({ limit: "12mb" }));
app.use(express.urlencoded({ extended: false, limit: "200kb" }));
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
      SELECT u.id, u.org_id, u.name, u.email, u.password_hash, u.role, u.tenant_id, o.name AS company_name
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
      companyName: sanitizeText(user.company_name),
      tenantId: user.tenant_id || null
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

app.post("/api/tenant-access", requireAuth, requireOwner, async (req, res) => {
  try {
    const tenantId = sanitizeText(req.body.tenantId || "");
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const tenantNameResult = ensureRequiredText(req.body.name, "Imię i nazwisko najemcy");

    if (!tenantId || !email || !password || tenantNameResult.error) {
      return res.status(400).json({ error: "Uzupełnij dane dostępu najemcy." });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Podaj poprawny e-mail najemcy." });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: "Hasło dla najemcy musi mieć co najmniej 8 znaków." });
    }

    const state = await getOrganizationState(req.session.user.orgId, req.session.user.companyName);
    if (!state) {
      return res.status(404).json({ error: "Nie znaleziono danych organizacji." });
    }

    const tenant = state.tenants.find((entry) => entry.id === tenantId);
    if (!tenant) {
      return res.status(404).json({ error: "Nie znaleziono najemcy o podanym identyfikatorze." });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const existing = await client.query(
        "SELECT id, role, tenant_id FROM users WHERE email = $1 LIMIT 1",
        [email]
      );

      if (existing.rows.length && existing.rows[0].role !== "tenant") {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Ten e-mail jest już używany przez konto właściciela lub administratora." });
      }

      const passwordHash = await bcrypt.hash(password, 12);
      const tenantUserId = existing.rows[0]?.id || uid("usr");

      if (existing.rows.length) {
        await client.query(
          "UPDATE users SET org_id = $1, name = $2, password_hash = $3, role = $4, tenant_id = $5 WHERE id = $6",
          [req.session.user.orgId, tenantNameResult.value, passwordHash, "tenant", tenantId, tenantUserId]
        );
      } else {
        await client.query(
          "INSERT INTO users (id, org_id, name, email, password_hash, role, tenant_id) VALUES ($1, $2, $3, $4, $5, $6, $7)",
          [tenantUserId, req.session.user.orgId, tenantNameResult.value, email, passwordHash, "tenant", tenantId]
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return res.json({ ok: true, tenantId, email });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Nie udało się utworzyć dostępu dla najemcy." });
  }
});

app.post("/api/tenant-access/delete", requireAuth, requireOwner, async (req, res) => {
  try {
    const tenantId = sanitizeText(req.body.tenantId || "");
    if (!tenantId) {
      return res.status(400).json({ error: "Brakuje identyfikatora najemcy." });
    }

    const result = await pool.query(
      "DELETE FROM users WHERE org_id = $1 AND role = $2 AND tenant_id = $3 RETURNING id",
      [req.session.user.orgId, "tenant", tenantId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Nie znaleziono konta dostępowego dla tego najemcy." });
    }

    return res.json({ ok: true, tenantId });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Nie udało się usunąć konta najemcy." });
  }
});

app.get("/api/state", requireAuth, async (req, res) => {
  try {
    const state = await getOrganizationState(req.session.user.orgId, req.session.user.companyName);
    if (!state) {
      return res.status(404).json({ error: "Brak danych organizacji." });
    }

    if (req.session.user.role === "tenant") {
      return res.json(buildTenantState(state, req.session.user.tenantId));
    }

    return res.json(state);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Nie udało się pobrać danych." });
  }
});

app.post("/api/state", requireAuth, async (req, res) => {
  try {
    if (req.session.user.role !== "owner") {
      return res.status(403).json({ error: "Najemca nie może modyfikować pełnego stanu aplikacji." });
    }

    await saveOrganizationState(req.session.user.orgId, req.session.user.companyName, req.body);

    return res.json({ ok: true, savedAt: new Date().toISOString() });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Nie udało się zapisać danych." });
  }
});

app.post("/api/tenant/tickets", requireAuth, requireTenant, async (req, res) => {
  try {
    const state = await getOrganizationState(req.session.user.orgId, req.session.user.companyName);
    if (!state) {
      return res.status(404).json({ error: "Brak danych organizacji." });
    }

    const tenantState = buildTenantState(state, req.session.user.tenantId);
    const tenant = tenantState.tenants[0];
    const lease = tenantState.leases.find((entry) => entry.status === "aktywna") || tenantState.leases[0];
    const unitId = lease?.unitId || tenant?.unitId;
    const titleResult = ensureRequiredText(req.body.title, "Tytuł zgłoszenia");
    const notes = sanitizeText(req.body.notes || "");
    const priority = ["niski", "średni", "wysoki"].includes(req.body.priority) ? req.body.priority : "średni";

    if (!unitId || titleResult.error) {
      return res.status(400).json({ error: "Nie udało się utworzyć zgłoszenia. Brakuje lokalu lub tytułu." });
    }

    state.tickets.push({
      id: uid("tk"),
      createdAt: new Date().toISOString().slice(0, 10),
      unitId,
      tenantId: req.session.user.tenantId,
      title: titleResult.value,
      priority,
      status: "otwarte",
      assignee: "",
      notes,
      comments: notes ? [{
        id: uid("cmt"),
        authorRole: "tenant",
        authorName: req.session.user.name,
        message: notes,
        createdAt: new Date().toISOString()
      }] : []
    });

    await saveOrganizationState(req.session.user.orgId, req.session.user.companyName, state);

    return res.json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Nie udało się dodać zgłoszenia." });
  }
});

app.post("/api/tickets/comment", requireAuth, async (req, res) => {
  try {
    const ticketId = sanitizeText(req.body.ticketId || "");
    const messageResult = ensureRequiredText(req.body.message, "Treść wiadomości");

    if (!ticketId || messageResult.error) {
      return res.status(400).json({ error: "Dodaj wiadomość do zgłoszenia." });
    }

    const state = await getOrganizationState(req.session.user.orgId, req.session.user.companyName);
    if (!state) {
      return res.status(404).json({ error: "Brak danych organizacji." });
    }

    const ticket = state.tickets.find((entry) => entry.id === ticketId);
    if (!ticket || !canAccessTicket(req.session.user, ticket, state)) {
      return res.status(404).json({ error: "Nie znaleziono zgłoszenia." });
    }

    ticket.comments = Array.isArray(ticket.comments) ? ticket.comments : [];
    const commentCreatedAt = new Date().toISOString();
    ticket.comments.push({
      id: uid("cmt"),
      authorRole: req.session.user.role,
      authorName: req.session.user.name,
      message: messageResult.value,
      createdAt: commentCreatedAt
    });
    ticket.lastCommentAt = commentCreatedAt;

    await saveOrganizationState(req.session.user.orgId, req.session.user.companyName, state);
    return res.json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Nie udało się dodać komentarza." });
  }
});

app.post("/api/tickets/status", requireAuth, requireOwner, async (req, res) => {
  try {
    const ticketId = sanitizeText(req.body.ticketId || "");
    const status = ["otwarte", "w trakcie", "zamknięte"].includes(req.body.status) ? req.body.status : "";
    const assignee = sanitizeText(req.body.assignee || "");

    if (!ticketId || !status) {
      return res.status(400).json({ error: "Brakuje zgłoszenia lub statusu." });
    }

    const state = await getOrganizationState(req.session.user.orgId, req.session.user.companyName);
    if (!state) {
      return res.status(404).json({ error: "Brak danych organizacji." });
    }

    const ticket = state.tickets.find((entry) => entry.id === ticketId);
    if (!ticket) {
      return res.status(404).json({ error: "Nie znaleziono zgłoszenia." });
    }

    const previousStatus = ticket.status || "otwarte";
    const previousAssignee = ticket.assignee || "";
    const statusChangedAt = new Date().toISOString();
    ticket.status = status;
    ticket.assignee = assignee;
    ticket.comments = Array.isArray(ticket.comments) ? ticket.comments : [];

    if (status === "w trakcie" && !ticket.startedAt) {
      ticket.startedAt = statusChangedAt;
    }
    if (status === "zamknięte") {
      ticket.startedAt = ticket.startedAt || statusChangedAt;
      ticket.resolvedAt = statusChangedAt;
    }
    if (status !== "zamknięte" && previousStatus === "zamknięte") {
      ticket.resolvedAt = "";
    }

    if (previousStatus !== status || previousAssignee !== assignee) {
      const changes = [];
      if (previousStatus !== status) changes.push(`status: ${previousStatus} -> ${status}`);
      if (previousAssignee !== assignee) changes.push(`opiekun: ${previousAssignee || "brak"} -> ${assignee || "brak"}`);
      ticket.comments.push({
        id: uid("cmt"),
        authorRole: "owner",
        authorName: req.session.user.name,
        message: `Aktualizacja zgłoszenia (${changes.join(", ")})`,
        createdAt: statusChangedAt
      });
      ticket.lastCommentAt = statusChangedAt;
    }

    await saveOrganizationState(req.session.user.orgId, req.session.user.companyName, state);
    return res.json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Nie udało się zaktualizować zgłoszenia." });
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
