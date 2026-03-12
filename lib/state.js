const COLLECTION_KEYS = [
  "buildings",
  "units",
  "tenants",
  "leases",
  "meters",
  "meterReadings",
  "charges",
  "payments",
  "expenses",
  "tickets",
  "settlements",
  "periodSettlements"
];

function sanitizeText(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .trim();
}

function sanitizeDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeDeep);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [key, sanitizeDeep(entryValue)])
    );
  }

  if (typeof value === "string") {
    return sanitizeText(value);
  }

  return value;
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
    periodSettlements: [],
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

function normalizeState(rawState, companyName = "RentFlow") {
  const defaults = buildEmptyState(companyName);
  const safeState = sanitizeDeep(rawState && typeof rawState === "object" ? rawState : {});
  const normalized = {
    ...defaults,
    ...safeState,
    settings: {
      ...defaults.settings,
      ...(safeState.settings || {})
    }
  };

  COLLECTION_KEYS.forEach((key) => {
    if (!Array.isArray(normalized[key])) {
      normalized[key] = [];
    }
  });

  normalized.settings.utilityVAT = Number(normalized.settings.utilityVAT || 23);
  normalized.settings.lateFee = Number(normalized.settings.lateFee || 50);
  normalized.settings.paymentDueDay = Number(normalized.settings.paymentDueDay || 10);

  normalized.leases = normalized.leases.map((lease) => ({
    ...lease,
    advanceColdWater: Number(lease.advanceColdWater || 0),
    advanceHotWater: Number(lease.advanceHotWater || 0),
    advanceElectricity: Number(lease.advanceElectricity || 0),
    advanceGas: Number(lease.advanceGas || 0),
    advanceHeat: Number(lease.advanceHeat || 0),
    feeWaste: Number(lease.feeWaste || 0),
    feeInternet: Number(lease.feeInternet || 0),
    rentDueDay: Number(lease.rentDueDay || 5),
    otherDueDay: Number(lease.otherDueDay || 10),
    rent: Number(lease.rent || 0),
    deposit: Number(lease.deposit || 0)
  }));

  return cleanupStateRelationships(normalized);
}

function cleanupStateRelationships(state) {
  const nextState = {
    ...state,
    buildings: [...state.buildings]
  };

  const buildingIds = new Set(nextState.buildings.map((building) => building.id));

  nextState.units = state.units.filter((unit) => buildingIds.has(unit.buildingId));
  const unitIds = new Set(nextState.units.map((unit) => unit.id));

  nextState.tenants = state.tenants.map((tenant) => ({
    ...tenant,
    unitId: unitIds.has(tenant.unitId) ? tenant.unitId : ""
  }));
  const tenantIds = new Set(nextState.tenants.map((tenant) => tenant.id));

  nextState.leases = state.leases.filter(
    (lease) => unitIds.has(lease.unitId) && tenantIds.has(lease.tenantId)
  );
  const leaseIds = new Set(nextState.leases.map((lease) => lease.id));

  nextState.meters = state.meters.filter((meter) => unitIds.has(meter.unitId));
  const meterIds = new Set(nextState.meters.map((meter) => meter.id));

  nextState.meterReadings = state.meterReadings.filter((reading) => meterIds.has(reading.meterId));

  nextState.charges = state.charges.filter((charge) => leaseIds.has(charge.leaseId));
  const chargeIds = new Set(nextState.charges.map((charge) => charge.id));

  nextState.payments = state.payments.filter(
    (payment) => chargeIds.has(payment.chargeId) && leaseIds.has(payment.leaseId)
  );

  nextState.expenses = state.expenses.filter(
    (expense) =>
      (!expense.buildingId || buildingIds.has(expense.buildingId)) &&
      (!expense.unitId || unitIds.has(expense.unitId))
  );

  nextState.tickets = state.tickets.filter(
    (ticket) => unitIds.has(ticket.unitId) && (!ticket.tenantId || tenantIds.has(ticket.tenantId))
  );

  nextState.settlements = state.settlements.filter(
    (settlement) =>
      (!settlement.leaseId || leaseIds.has(settlement.leaseId)) &&
      (!settlement.tenantId || tenantIds.has(settlement.tenantId)) &&
      (!settlement.unitId || unitIds.has(settlement.unitId))
  );

  nextState.periodSettlements = state.periodSettlements.filter(
    (settlement) => !settlement.tenantId || tenantIds.has(settlement.tenantId)
  );

  return nextState;
}

module.exports = {
  buildEmptyState,
  buildTenantState,
  cleanupStateRelationships,
  normalizeState,
  sanitizeDeep,
  sanitizeText
};

function buildTenantState(state, tenantId) {
  const normalized = cleanupStateRelationships(normalizeState(state));
  const tenant = normalized.tenants.find((entry) => entry.id === tenantId);

  if (!tenant) {
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
      periodSettlements: [],
      settings: {
        companyName: normalized.settings.companyName || "RentFlow",
        ownerName: normalized.settings.ownerName || "",
        baseCurrency: normalized.settings.baseCurrency || "PLN",
        bankAccount: normalized.settings.bankAccount || "",
        paymentDueDay: normalized.settings.paymentDueDay || 10
      }
    };
  }

  const leases = normalized.leases.filter((lease) => lease.tenantId === tenantId);
  const leaseIds = new Set(leases.map((lease) => lease.id));
  const unitIds = new Set(leases.map((lease) => lease.unitId).filter(Boolean));
  if (tenant.unitId) unitIds.add(tenant.unitId);

  const units = normalized.units.filter((unit) => unitIds.has(unit.id));
  const buildingIds = new Set(units.map((unit) => unit.buildingId).filter(Boolean));
  const buildings = normalized.buildings.filter((building) => buildingIds.has(building.id));
  const meters = normalized.meters.filter((meter) => unitIds.has(meter.unitId));
  const meterIds = new Set(meters.map((meter) => meter.id));
  const charges = normalized.charges.filter((charge) => leaseIds.has(charge.leaseId));
  const chargeIds = new Set(charges.map((charge) => charge.id));

  return {
    buildings,
    units,
    tenants: [tenant],
    leases,
    meters,
    meterReadings: normalized.meterReadings.filter((reading) => meterIds.has(reading.meterId)),
    charges,
    payments: normalized.payments.filter(
      (payment) => leaseIds.has(payment.leaseId) || chargeIds.has(payment.chargeId)
    ),
    expenses: [],
    tickets: normalized.tickets.filter(
      (ticket) => ticket.tenantId === tenantId || unitIds.has(ticket.unitId)
    ),
    settlements: normalized.settlements.filter((settlement) => settlement.tenantId === tenantId),
    periodSettlements: normalized.periodSettlements.filter((settlement) => settlement.tenantId === tenantId),
    settings: {
      companyName: normalized.settings.companyName || "RentFlow",
      ownerName: normalized.settings.ownerName || "",
      baseCurrency: normalized.settings.baseCurrency || "PLN",
      bankAccount: normalized.settings.bankAccount || "",
      paymentDueDay: normalized.settings.paymentDueDay || 10
    }
  };
}
