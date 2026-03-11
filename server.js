const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const dataDir = path.join(__dirname, "data");
const dbPath = path.join(dataDir, "db.json");

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

function ensureDb() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  if (!fs.existsSync(dbPath)) {
    const demo = buildDemoData();
    fs.writeFileSync(dbPath, JSON.stringify(demo, null, 2), "utf-8");
  }
}

function readDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(dbPath, "utf-8"));
}

function writeDb(data) {
  ensureDb();
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), "utf-8");
}

function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function buildDemoData() {
  const state = {
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
    settings: {
      companyName: "RentFlow Pro",
      ownerName: "Zarządca",
      baseCurrency: "PLN",
      utilityVAT: 23,
      lateFee: 50
    }
  };

  const buildingNames = [
    "Kamienica Rynek 12",
    "Apartamenty Leśna 4",
    "Osiedle Słoneczne 7",
    "Budynek Parkowa 21"
  ];

  buildingNames.forEach((name, bi) => {
    const bId = uid("b");
    state.buildings.push({
      id: bId,
      name,
      address: `${name}, Polska`,
      notes: "",
      createdAt: today()
    });

    for (let i = 1; i <= 5; i++) {
      const rent = 1700 + bi * 250 + i * 80;
      const uId = uid("u");

      state.units.push({
        id: uId,
        buildingId: bId,
        code: `${bi + 1}${String(i).padStart(2, "0")}`,
        type: i % 3 === 0 ? "2 pokoje" : i % 2 === 0 ? "kawalerka" : "3 pokoje",
        area: 28 + i * 8,
        floor: Math.min(i, 4),
        rentDefault: rent,
        serviceCharge: 280 + i * 20,
        status: i === 5 && bi === 3 ? "wolne" : "wynajęte",
        notes: ""
      });
    }
  });

  const firstNames = [
    "Anna", "Jan", "Marek", "Julia", "Katarzyna",
    "Piotr", "Oliwia", "Michał", "Paweł", "Natalia",
    "Adam", "Weronika", "Ewa", "Krzysztof", "Alicja",
    "Karol", "Dominika", "Robert", "Patrycja"
  ];

  const lastNames = [
    "Nowak", "Kowalski", "Wiśniewski", "Wójcik", "Kamińska",
    "Lewandowski", "Zielińska", "Szymański", "Dąbrowska", "Kozłowski"
  ];

  state.units
    .filter((u) => u.status === "wynajęte")
    .forEach((unit, idx) => {
      const tenantId = uid("t");
      const leaseId = uid("l");
      const name = `${firstNames[idx % firstNames.length]} ${lastNames[idx % lastNames.length]}`;

      state.tenants.push({
        id: tenantId,
        name,
        phone: `500600${String(10 + idx).padStart(2, "0")}`,
        email: `tenant${idx + 1}@mail.pl`,
        unitId: unit.id,
        status: "aktywny",
        notes: ""
      });

      const start = new Date();
      start.setMonth(start.getMonth() - (idx % 9) - 1);
      const end = new Date(start);
      end.setFullYear(end.getFullYear() + 1);

      state.leases.push({
        id: leaseId,
        tenantId,
        unitId: unit.id,
        startDate: start.toISOString().slice(0, 10),
        endDate: end.toISOString().slice(0, 10),
        rent: unit.rentDefault,
        deposit: unit.rentDefault,
        billingDay: 5,
        status: "aktywna",
        notes: ""
      });

      const chargeId = uid("c");

      state.charges.push({
        id: chargeId,
        leaseId,
        type: "Czynsz miesięczny",
        amount: unit.rentDefault + unit.serviceCharge,
        dueDate: today(),
        status: idx % 5 === 0 ? "zaległe" : "oczekujące",
        notes: "Czynsz + opłata administracyjna"
      });

      if (idx % 3 !== 0) {
        state.payments.push({
          id: uid("p"),
          leaseId,
          chargeId,
          date: today(),
          amount: unit.rentDefault + unit.serviceCharge - (idx % 4 === 0 ? 200 : 0),
          method: "przelew",
          notes: ""
        });
      }
    });

  state.units.forEach((unit, idx) => {
    ["prąd", "woda", "gaz"].forEach((kind, k) => {
      const meterId = uid("m");
      const rate = kind === "prąd" ? 1.35 : kind === "woda" ? 14.8 : 4.2;

      state.meters.push({
        id: meterId,
        unitId: unit.id,
        type: kind,
        serial: `${kind.slice(0, 2).toUpperCase()}-${idx + 1}-${k + 1}`,
        rate,
        unit: kind === "prąd" ? "kWh" : "m³"
      });

      const prev = 1000 + idx * 30 + k * 50;
      const curr = prev + 18 + (idx % 7) * 3 + k * 2;

      state.meterReadings.push({
        id: uid("r"),
        meterId,
        date: new Date(new Date().setMonth(new Date().getMonth() - 1)).toISOString().slice(0, 10),
        value: prev,
        notes: "Poprzedni odczyt"
      });

      state.meterReadings.push({
        id: uid("r"),
        meterId,
        date: today(),
        value: curr,
        notes: "Bieżący odczyt"
      });
    });
  });

  state.expenses.push(
    {
      id: uid("e"),
      date: today(),
      buildingId: state.buildings[0]?.id || "",
      unitId: "",
      category: "Sprzątanie",
      amount: 380,
      vendor: "Clean Sp. z o.o.",
      notes: "Części wspólne"
    },
    {
      id: uid("e"),
      date: today(),
      buildingId: state.buildings[1]?.id || "",
      unitId: "",
      category: "Ubezpieczenie",
      amount: 1200,
      vendor: "TU Bezpieczny Dom",
      notes: "Roczne"
    },
    {
      id: uid("e"),
      date: today(),
      buildingId: state.buildings[2]?.id || "",
      unitId: state.units[3]?.id || "",
      category: "Naprawa AGD",
      amount: 450,
      vendor: "Serwis AGD",
      notes: "Lodówka"
    }
  );

  state.tickets.push(
    {
      id: uid("tk"),
      createdAt: today(),
      unitId: state.units[0]?.id || "",
      tenantId: state.tenants[0]?.id || "",
      title: "Cieknący syfon w kuchni",
      priority: "średni",
      status: "otwarte",
      assignee: "Hydraulik",
      notes: "Do sprawdzenia po 16:00"
    },
    {
      id: uid("tk"),
      createdAt: today(),
      unitId: state.units[2]?.id || "",
      tenantId: state.tenants[2]?.id || "",
      title: "Nie działa piekarnik",
      priority: "wysoki",
      status: "w trakcie",
      assignee: "Serwis AGD",
      notes: ""
    },
    {
      id: uid("tk"),
      createdAt: today(),
      unitId: state.units[5]?.id || "",
      tenantId: state.tenants[5]?.id || "",
      title: "Wymiana zamka",
      priority: "niski",
      status: "zamknięte",
      assignee: "Ślusarz",
      notes: "Zrealizowano"
    }
  );

  return state;
}

app.get("/api/state", (req, res) => {
  try {
    const db = readDb();
    res.json(db);
  } catch (error) {
    res.status(500).json({ error: "Nie udało się odczytać danych." });
  }
});

app.post("/api/state", (req, res) => {
  try {
    writeDb(req.body);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: "Nie udało się zapisać danych." });
  }
});

app.post("/api/reset-demo", (req, res) => {
  try {
    const demo = buildDemoData();
    writeDb(demo);
    res.json({ ok: true, data: demo });
  } catch (error) {
    res.status(500).json({ error: "Nie udało się przywrócić danych demo." });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

ensureDb();

app.listen(PORT, () => {
  console.log(`RentFlow działa na http://localhost:${PORT}`);
});