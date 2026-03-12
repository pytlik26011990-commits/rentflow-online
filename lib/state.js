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
  "documents",
  "tasks",
  "generatedDocuments",
  "messages",
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

function defaultDocumentTemplates() {
  return {
    leaseAgreement: "",
    handoverProtocol: "",
    paymentDemand: "",
    leaseTermination: "",
    depositReceipt: "",
    paymentReceipt: ""
  };
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
    documents: [],
    tasks: [],
    generatedDocuments: [],
    messages: [],
    settlements: [],
    periodSettlements: [],
    settings: {
      companyName,
      ownerName: "",
      ownerAddress: "",
      ownerDocument: "",
      baseCurrency: "PLN",
      utilityVAT: 23,
      lateFee: 50,
      bankAccount: "",
      paymentDueDay: 10,
      reminderDaysBeforeDue: 3,
      reminderDaysBeforeLeaseEnd: 45,
      reminderDaysBeforeDocumentExpiry: 30,
      documentTemplates: defaultDocumentTemplates()
    }
  };
}

function asIsoDateTime(value) {
  if (!value) return "";
  if (typeof value === "string" && value.length === 10) return `${value}T09:00:00.000Z`;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}

function addHours(dateValue, hours) {
  const base = new Date(asIsoDateTime(dateValue) || Date.now());
  base.setHours(base.getHours() + Number(hours || 0));
  return base.toISOString();
}

function ticketSlaTargets(priority, createdAt) {
  const normalizedPriority = ["niski", "średni", "wysoki"].includes(priority) ? priority : "średni";
  const matrix = {
    niski: { responseHours: 24, resolutionHours: 120 },
    "średni": { responseHours: 8, resolutionHours: 72 },
    wysoki: { responseHours: 2, resolutionHours: 24 }
  };
  const selected = matrix[normalizedPriority];
  return {
    responseHours: selected.responseHours,
    resolutionHours: selected.resolutionHours,
    targetResponseAt: addHours(createdAt, selected.responseHours),
    targetResolutionAt: addHours(createdAt, selected.resolutionHours)
  };
}

function normalizeTicket(ticket) {
  const createdAt = asIsoDateTime(ticket?.createdAt) || new Date().toISOString();
  const priority = ["niski", "średni", "wysoki"].includes(ticket?.priority) ? ticket.priority : "średni";
  const status = ["otwarte", "w trakcie", "zamknięte"].includes(ticket?.status) ? ticket.status : "otwarte";
  const defaults = ticketSlaTargets(priority, createdAt);

  return {
    ...ticket,
    createdAt,
    priority,
    status,
    responseHours: Number(ticket?.responseHours || defaults.responseHours),
    resolutionHours: Number(ticket?.resolutionHours || defaults.resolutionHours),
    targetResponseAt: asIsoDateTime(ticket?.targetResponseAt) || defaults.targetResponseAt,
    targetResolutionAt: asIsoDateTime(ticket?.targetResolutionAt) || defaults.targetResolutionAt,
    startedAt: asIsoDateTime(ticket?.startedAt),
    resolvedAt: asIsoDateTime(ticket?.resolvedAt),
    lastCommentAt: asIsoDateTime(ticket?.lastCommentAt),
    comments: Array.isArray(ticket?.comments)
      ? ticket.comments.map((comment) => ({
          ...comment,
          message: sanitizeText(comment?.message || ""),
          authorName: sanitizeText(comment?.authorName || ""),
          authorRole: sanitizeText(comment?.authorRole || ""),
          createdAt: asIsoDateTime(comment?.createdAt)
        }))
      : []
  };
}

function normalizeDocument(document) {
  return {
    ...document,
    attachments: Array.isArray(document?.attachments)
      ? document.attachments.map((attachment) => ({
          id: sanitizeText(attachment?.id || ""),
          name: sanitizeText(attachment?.name || "plik"),
          type: sanitizeText(attachment?.type || "application/octet-stream"),
          size: Number(attachment?.size || 0),
          dataUrl: String(attachment?.dataUrl || "")
        }))
      : []
  };
}

function normalizeMessage(message) {
  return {
    ...message,
    subject: sanitizeText(message?.subject || ""),
    status: ["otwarta", "zamknięta"].includes(message?.status) ? message.status : "otwarta",
    priority: ["normalna", "pilna"].includes(message?.priority) ? message.priority : "normalna",
    createdAt: asIsoDateTime(message?.createdAt) || new Date().toISOString(),
    updatedAt: asIsoDateTime(message?.updatedAt) || asIsoDateTime(message?.createdAt) || new Date().toISOString(),
    thread: Array.isArray(message?.thread)
      ? message.thread.map((entry) => ({
          ...entry,
          authorName: sanitizeText(entry?.authorName || ""),
          authorRole: sanitizeText(entry?.authorRole || ""),
          body: sanitizeText(entry?.body || ""),
          createdAt: asIsoDateTime(entry?.createdAt) || new Date().toISOString(),
          attachments: Array.isArray(entry?.attachments)
            ? entry.attachments.map((attachment) => ({
                id: sanitizeText(attachment?.id || ""),
                name: sanitizeText(attachment?.name || "plik"),
                type: sanitizeText(attachment?.type || "application/octet-stream"),
                size: Number(attachment?.size || 0),
                dataUrl: String(attachment?.dataUrl || "")
              }))
            : []
        }))
      : []
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
  normalized.settings.reminderDaysBeforeDue = Number(normalized.settings.reminderDaysBeforeDue || 3);
  normalized.settings.reminderDaysBeforeLeaseEnd = Number(normalized.settings.reminderDaysBeforeLeaseEnd || 45);
  normalized.settings.reminderDaysBeforeDocumentExpiry = Number(normalized.settings.reminderDaysBeforeDocumentExpiry || 30);
  normalized.settings.documentTemplates = {
    ...defaultDocumentTemplates(),
    ...(safeState.settings?.documentTemplates || {})
  };

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

  normalized.tickets = normalized.tickets.map(normalizeTicket);
  normalized.documents = normalized.documents.map(normalizeDocument);
  normalized.messages = normalized.messages.map(normalizeMessage);

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

  nextState.documents = state.documents.filter(
    (document) =>
      (!document.tenantId || tenantIds.has(document.tenantId)) &&
      (!document.leaseId || leaseIds.has(document.leaseId)) &&
      (!document.unitId || unitIds.has(document.unitId))
  );

  nextState.tasks = state.tasks.filter(
    (task) =>
      (!task.tenantId || tenantIds.has(task.tenantId)) &&
      (!task.leaseId || leaseIds.has(task.leaseId)) &&
      (!task.unitId || unitIds.has(task.unitId))
  );

  nextState.generatedDocuments = state.generatedDocuments.filter(
    (document) =>
      (!document.tenantId || tenantIds.has(document.tenantId)) &&
      (!document.leaseId || leaseIds.has(document.leaseId)) &&
      (!document.unitId || unitIds.has(document.unitId))
  );

  nextState.messages = state.messages.filter(
    (message) =>
      (!message.tenantId || tenantIds.has(message.tenantId)) &&
      (!message.leaseId || leaseIds.has(message.leaseId)) &&
      (!message.unitId || unitIds.has(message.unitId))
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
      documents: [],
      tasks: [],
      generatedDocuments: [],
      messages: [],
      settlements: [],
      periodSettlements: [],
      settings: {
        companyName: normalized.settings.companyName || "RentFlow",
        ownerName: normalized.settings.ownerName || "",
        ownerAddress: normalized.settings.ownerAddress || "",
        ownerDocument: normalized.settings.ownerDocument || "",
        baseCurrency: normalized.settings.baseCurrency || "PLN",
        bankAccount: normalized.settings.bankAccount || "",
        paymentDueDay: normalized.settings.paymentDueDay || 10,
        reminderDaysBeforeDue: normalized.settings.reminderDaysBeforeDue || 3,
        reminderDaysBeforeLeaseEnd: normalized.settings.reminderDaysBeforeLeaseEnd || 45,
        reminderDaysBeforeDocumentExpiry: normalized.settings.reminderDaysBeforeDocumentExpiry || 30,
        documentTemplates: {
          ...defaultDocumentTemplates(),
          ...(normalized.settings.documentTemplates || {})
        }
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
    documents: normalized.documents.filter((document) => {
      const isVisible = ["tenant", "shared"].includes(document.visibility || "owner");
      const matchesTenant = !document.tenantId || document.tenantId === tenantId;
      const matchesLease = !document.leaseId || leaseIds.has(document.leaseId);
      const matchesUnit = !document.unitId || unitIds.has(document.unitId);
      return isVisible && matchesTenant && matchesLease && matchesUnit;
    }),
    tasks: normalized.tasks.filter((task) => {
      const isVisible = ["tenant", "shared"].includes(task.visibility || "owner");
      const matchesTenant = !task.tenantId || task.tenantId === tenantId;
      const matchesLease = !task.leaseId || leaseIds.has(task.leaseId);
      const matchesUnit = !task.unitId || unitIds.has(task.unitId);
      return isVisible && matchesTenant && matchesLease && matchesUnit;
    }),
    messages: normalized.messages.filter((message) => {
      const matchesTenant = !message.tenantId || message.tenantId === tenantId;
      const matchesLease = !message.leaseId || leaseIds.has(message.leaseId);
      const matchesUnit = !message.unitId || unitIds.has(message.unitId);
      return matchesTenant && matchesLease && matchesUnit;
    }),
    settlements: normalized.settlements.filter((settlement) => settlement.tenantId === tenantId),
    periodSettlements: normalized.periodSettlements.filter((settlement) => settlement.tenantId === tenantId),
    settings: {
      companyName: normalized.settings.companyName || "RentFlow",
      ownerName: normalized.settings.ownerName || "",
      ownerAddress: normalized.settings.ownerAddress || "",
      ownerDocument: normalized.settings.ownerDocument || "",
      baseCurrency: normalized.settings.baseCurrency || "PLN",
      bankAccount: normalized.settings.bankAccount || "",
      paymentDueDay: normalized.settings.paymentDueDay || 10,
      reminderDaysBeforeDue: normalized.settings.reminderDaysBeforeDue || 3,
      reminderDaysBeforeLeaseEnd: normalized.settings.reminderDaysBeforeLeaseEnd || 45,
      reminderDaysBeforeDocumentExpiry: normalized.settings.reminderDaysBeforeDocumentExpiry || 30,
      documentTemplates: {
        ...defaultDocumentTemplates(),
        ...(normalized.settings.documentTemplates || {})
      }
    }
  };
}
