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
  const access = mergeUserAccess(user.role, user.permissions);
  req.session.user = {
    id: user.id,
    orgId: user.orgId,
    email: user.email,
    name: user.name,
    role: user.role,
    capabilities: access.capabilities,
    permissions: access.permissions,
    companyName: user.companyName,
    tenantId: user.tenantId || null,
    lastLoginAt: user.lastLoginAt || null,
    isActive: user.isActive !== false
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
  if (["owner", "manager", "accountant", "technician"].includes(user.role)) return true;
  if (user.role !== "tenant" || !user.tenantId) return false;
  if (ticket.tenantId === user.tenantId) return true;
  const tenantState = buildTenantState(state, user.tenantId);
  return tenantState.tickets.some((entry) => entry.id === ticket.id);
}

function capabilitiesForRole(role) {
  const matrix = {
    owner: {
      manageUsers: true,
      stateWrite: true,
      ticketWorkflow: true,
      fullWorkspace: true
    },
    manager: {
      manageUsers: false,
      stateWrite: true,
      ticketWorkflow: true,
      fullWorkspace: true
    },
    accountant: {
      manageUsers: false,
      stateWrite: true,
      ticketWorkflow: false,
      fullWorkspace: true
    },
    technician: {
      manageUsers: false,
      stateWrite: false,
      ticketWorkflow: true,
      fullWorkspace: false
    },
    tenant: {
      manageUsers: false,
      stateWrite: false,
      ticketWorkflow: false,
      fullWorkspace: false
    }
  };

  return matrix[role] || matrix.tenant;
}

function defaultPermissionsForRole(role) {
  const ownerAll = {
    dashboard: true,
    properties: true,
    tenants: true,
    tenantCard: true,
    leases: true,
    meters: true,
    settlements: true,
    periodSettlements: true,
    payments: true,
    expenses: true,
    maintenance: true,
    documents: true,
    tasks: true,
    communications: true,
    reports: true,
    settings: true
  };
  const matrix = {
    owner: ownerAll,
    manager: { ...ownerAll, settings: false },
    accountant: {
      dashboard: true,
      properties: false,
      tenants: true,
      tenantCard: true,
      leases: true,
      meters: false,
      settlements: true,
      periodSettlements: true,
      payments: true,
      expenses: true,
      maintenance: false,
      documents: true,
      tasks: false,
      communications: true,
      reports: true,
      settings: false
    },
    technician: {
      dashboard: true,
      properties: false,
      tenants: false,
      tenantCard: false,
      leases: false,
      meters: false,
      settlements: false,
      periodSettlements: false,
      payments: false,
      expenses: false,
      maintenance: true,
      documents: true,
      tasks: true,
      communications: true,
      reports: true,
      settings: false
    },
    tenant: {}
  };

  return matrix[role] || {};
}

function mergeUserAccess(role, permissions = {}) {
  return {
    capabilities: capabilitiesForRole(role),
    permissions: {
      ...defaultPermissionsForRole(role),
      ...(permissions && typeof permissions === "object" ? permissions : {})
    }
  };
}

function requireOwner(req, res, next) {
  if (!req.session.user || req.session.user.role !== "owner") {
    return res.status(403).json({ error: "Ta operacja jest dostępna tylko dla właściciela." });
  }

  return next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user || !roles.includes(req.session.user.role)) {
      return res.status(403).json({ error: "Brak uprawnień do wykonania tej operacji." });
    }

    return next();
  };
}

function requireCapability(capability) {
  return (req, res, next) => {
    const capabilities = req.session.user ? (req.session.user.capabilities || capabilitiesForRole(req.session.user.role)) : null;
    if (!req.session.user || !capabilities?.[capability]) {
      return res.status(403).json({ error: "Twoje konto nie ma wymaganych uprawnień." });
    }

    return next();
  };
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
        companyName,
        permissions: defaultPermissionsForRole("owner"),
        isActive: true,
        lastLoginAt: null
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
      SELECT u.id, u.org_id, u.name, u.email, u.password_hash, u.role, u.tenant_id, u.is_active, u.last_login_at, u.permissions, o.name AS company_name
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
    if (user.is_active === false) {
      return res.status(403).json({ error: "To konto jest obecnie wyłączone." });
    }
    const passwordValid = await bcrypt.compare(password, user.password_hash);

    if (!passwordValid) {
      return res.status(401).json({ error: "Nieprawidłowy login lub hasło." });
    }

    await pool.query("UPDATE users SET last_login_at = NOW() WHERE id = $1", [user.id]);
    await regenerateSession(req);
    setAuthenticatedUser(req, {
      id: user.id,
      orgId: user.org_id,
      email: user.email,
      name: sanitizeText(user.name),
      role: user.role,
      companyName: sanitizeText(user.company_name),
      tenantId: user.tenant_id || null,
      permissions: user.permissions || {},
      isActive: user.is_active !== false,
      lastLoginAt: new Date().toISOString()
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

  const access = mergeUserAccess(req.session.user.role, req.session.user.permissions);
  req.session.user.capabilities = access.capabilities;
  req.session.user.permissions = access.permissions;
  return res.json(req.session.user);
});

app.get("/api/team-users", requireAuth, requireOwner, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT id, name, email, role, created_at, last_login_at, is_active, permissions
      FROM users
      WHERE org_id = $1 AND role <> 'tenant'
      ORDER BY created_at ASC
      `,
      [req.session.user.orgId]
    );

    return res.json(result.rows.map((row) => ({
      id: row.id,
      name: sanitizeText(row.name),
      email: row.email,
      role: row.role,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at,
      isActive: row.is_active !== false,
      permissions: mergeUserAccess(row.role, row.permissions || {}).permissions
    })));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Nie udało się pobrać zespołu." });
  }
});

app.post("/api/team-users", requireAuth, requireOwner, async (req, res) => {
  try {
    const role = ["manager", "accountant", "technician"].includes(req.body.role) ? req.body.role : "";
    const nameResult = ensureRequiredText(req.body.name, "Imię i nazwisko");
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const permissions = mergeUserAccess(role, req.body.permissions || {}).permissions;

    if (!role || nameResult.error || !email || password.length < 8) {
      return res.status(400).json({ error: "Uzupełnij dane członka zespołu i ustaw hasło min. 8 znaków." });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Podaj poprawny adres e-mail." });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query(
        "SELECT id, org_id, role FROM users WHERE email = $1 LIMIT 1",
        [email]
      );

      if (existing.rows.length) {
        const row = existing.rows[0];
        if (row.org_id !== req.session.user.orgId || row.role === "tenant" || row.role === "owner") {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Ten e-mail jest już zajęty przez konto, którego nie można zamienić na konto zespołu." });
        }

        await client.query(
          "UPDATE users SET name = $1, password_hash = $2, role = $3, tenant_id = NULL, permissions = $4::jsonb, is_active = TRUE WHERE id = $5",
          [nameResult.value, await bcrypt.hash(password, 12), role, JSON.stringify(permissions), row.id]
        );
      } else {
        await client.query(
          "INSERT INTO users (id, org_id, name, email, password_hash, role, tenant_id, permissions, is_active) VALUES ($1, $2, $3, $4, $5, $6, NULL, $7::jsonb, TRUE)",
          [uid("usr"), req.session.user.orgId, nameResult.value, email, await bcrypt.hash(password, 12), role, JSON.stringify(permissions)]
        );
      }

      await client.query("COMMIT");
      return res.json({ ok: true });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Nie udało się zapisać konta zespołu." });
  }
});

app.post("/api/team-users/status", requireAuth, requireOwner, async (req, res) => {
  try {
    const userId = sanitizeText(req.body.userId || "");
    const isActive = req.body.isActive !== false;
    if (!userId) {
      return res.status(400).json({ error: "Brakuje identyfikatora użytkownika." });
    }

    const result = await pool.query(
      "UPDATE users SET is_active = $1 WHERE org_id = $2 AND id = $3 AND role IN ('manager', 'accountant', 'technician') RETURNING id",
      [isActive, req.session.user.orgId, userId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Nie znaleziono konta zespołu." });
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Nie udało się zmienić statusu konta." });
  }
});

app.post("/api/team-users/delete", requireAuth, requireOwner, async (req, res) => {
  try {
    const userId = sanitizeText(req.body.userId || "");
    if (!userId) {
      return res.status(400).json({ error: "Brakuje identyfikatora użytkownika." });
    }

    const result = await pool.query(
      "DELETE FROM users WHERE org_id = $1 AND id = $2 AND role IN ('manager', 'accountant', 'technician') RETURNING id",
      [req.session.user.orgId, userId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Nie znaleziono konta zespołu." });
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Nie udało się usunąć konta zespołu." });
  }
});

app.post("/api/tenant-access", requireAuth, requireOwner, async (req, res) => {
  try {
    const tenantId = sanitizeText(req.body.tenantId || "");
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const tenantNameResult = ensureRequiredText(req.body.name, "Imię i nazwisko najemcy");

    if (!tenantId || !email || tenantNameResult.error) {
      return res.status(400).json({ error: "Uzupełnij dane dostępu najemcy." });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Podaj poprawny e-mail najemcy." });
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

      const existingForTenant = await client.query(
        "SELECT id, role, tenant_id, password_hash FROM users WHERE org_id = $1 AND role = 'tenant' AND tenant_id = $2 LIMIT 1",
        [req.session.user.orgId, tenantId]
      );
      const existingForEmail = await client.query(
        "SELECT id, role, tenant_id FROM users WHERE email = $1 LIMIT 1",
        [email]
      );

      if (existingForEmail.rows.length && existingForEmail.rows[0].role !== "tenant") {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Ten e-mail jest już używany przez konto właściciela lub administratora." });
      }

      if (existingForEmail.rows.length && existingForEmail.rows[0].tenant_id !== tenantId) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Ten e-mail jest już przypisany do innego konta najemcy." });
      }

      const tenantUserId = existingForTenant.rows[0]?.id || existingForEmail.rows[0]?.id || uid("usr");

      if (existingForTenant.rows.length || existingForEmail.rows.length) {
        const nextPasswordHash = password
          ? await bcrypt.hash(password, 12)
          : existingForTenant.rows[0]?.password_hash;
        if (!nextPasswordHash) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Podaj hasło dla nowego konta najemcy." });
        }
        await client.query(
          "UPDATE users SET org_id = $1, name = $2, email = $3, password_hash = $4, role = $5, tenant_id = $6, is_active = TRUE, permissions = '{}'::jsonb WHERE id = $7",
          [req.session.user.orgId, tenantNameResult.value, email, nextPasswordHash, "tenant", tenantId, tenantUserId]
        );
      } else {
        if (password.length < 8) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Hasło dla najemcy musi mieć co najmniej 8 znaków." });
        }
        await client.query(
          "INSERT INTO users (id, org_id, name, email, password_hash, role, tenant_id, is_active, permissions) VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, '{}'::jsonb)",
          [tenantUserId, req.session.user.orgId, tenantNameResult.value, email, await bcrypt.hash(password, 12), "tenant", tenantId]
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

app.get("/api/tenant-access-overview", requireAuth, requireOwner, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT id, tenant_id, name, email, last_login_at, is_active, created_at
      FROM users
      WHERE org_id = $1 AND role = 'tenant'
      ORDER BY created_at ASC
      `,
      [req.session.user.orgId]
    );

    return res.json(result.rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      name: sanitizeText(row.name),
      email: row.email,
      lastLoginAt: row.last_login_at,
      isActive: row.is_active !== false,
      createdAt: row.created_at
    })));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Nie udało się pobrać dostępu najemców." });
  }
});

app.post("/api/tenant-access/status", requireAuth, requireOwner, async (req, res) => {
  try {
    const tenantId = sanitizeText(req.body.tenantId || "");
    const isActive = req.body.isActive !== false;
    if (!tenantId) {
      return res.status(400).json({ error: "Brakuje identyfikatora najemcy." });
    }

    const result = await pool.query(
      "UPDATE users SET is_active = $1 WHERE org_id = $2 AND role = 'tenant' AND tenant_id = $3 RETURNING id",
      [isActive, req.session.user.orgId, tenantId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Nie znaleziono konta dostępowego dla tego najemcy." });
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Nie udało się zmienić statusu konta najemcy." });
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

app.post("/api/state", requireAuth, requireCapability("stateWrite"), async (req, res) => {
  try {
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

app.post("/api/tenant/messages", requireAuth, requireTenant, async (req, res) => {
  try {
    const subjectResult = ensureRequiredText(req.body.subject, "Temat wiadomości");
    const bodyResult = ensureRequiredText(req.body.body, "Treść wiadomości");
    const attachments = Array.isArray(req.body.attachments) ? req.body.attachments : [];
    if (subjectResult.error || bodyResult.error) {
      return res.status(400).json({ error: "Uzupełnij temat i treść wiadomości." });
    }

    const state = await getOrganizationState(req.session.user.orgId, req.session.user.companyName);
    if (!state) {
      return res.status(404).json({ error: "Brak danych organizacji." });
    }

    const tenantState = buildTenantState(state, req.session.user.tenantId);
    const tenant = tenantState.tenants[0];
    const lease = tenantState.leases.find((entry) => entry.status === "aktywna") || tenantState.leases[0];
    const unit = lease ? tenantState.units.find((entry) => entry.id === lease.unitId) : tenantState.units[0];
    const now = new Date().toISOString();

    state.messages.push({
      id: uid("msg"),
      tenantId: req.session.user.tenantId,
      leaseId: lease?.id || "",
      unitId: unit?.id || "",
      subject: subjectResult.value,
      priority: ["normalna", "pilna"].includes(req.body.priority) ? req.body.priority : "normalna",
      status: "otwarta",
      createdAt: now,
      updatedAt: now,
      thread: [{
        id: uid("msgline"),
        authorRole: "tenant",
        authorName: tenant?.name || req.session.user.name,
        body: bodyResult.value,
        createdAt: now,
        attachments
      }]
    });

    await saveOrganizationState(req.session.user.orgId, req.session.user.companyName, state);
    return res.json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Nie udało się wysłać wiadomości." });
  }
});

app.post("/api/tenant/messages/reply", requireAuth, requireTenant, async (req, res) => {
  try {
    const conversationId = sanitizeText(req.body.conversationId || "");
    const bodyResult = ensureRequiredText(req.body.body, "Treść wiadomości");
    const attachments = Array.isArray(req.body.attachments) ? req.body.attachments : [];
    if (!conversationId || bodyResult.error) {
      return res.status(400).json({ error: "Brakuje rozmowy lub treści wiadomości." });
    }

    const state = await getOrganizationState(req.session.user.orgId, req.session.user.companyName);
    if (!state) {
      return res.status(404).json({ error: "Brak danych organizacji." });
    }

    const conversation = state.messages.find((entry) => entry.id === conversationId && entry.tenantId === req.session.user.tenantId);
    if (!conversation) {
      return res.status(404).json({ error: "Nie znaleziono rozmowy." });
    }

    const tenantState = buildTenantState(state, req.session.user.tenantId);
    const tenant = tenantState.tenants[0];
    const now = new Date().toISOString();
    conversation.thread = Array.isArray(conversation.thread) ? conversation.thread : [];
    conversation.thread.push({
      id: uid("msgline"),
      authorRole: "tenant",
      authorName: tenant?.name || req.session.user.name,
      body: bodyResult.value,
      createdAt: now,
      attachments
    });
    conversation.updatedAt = now;
    conversation.status = "otwarta";

    await saveOrganizationState(req.session.user.orgId, req.session.user.companyName, state);
    return res.json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Nie udało się odpowiedzieć w rozmowie." });
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

app.post("/api/tickets/status", requireAuth, requireCapability("ticketWorkflow"), async (req, res) => {
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
