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
  "taxAdjustments",
  "taxPayments",
  "taxAnnualClosings",
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

function buildEmptyState(companyName = "RentHome") {
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
    taxAdjustments: [],
    taxPayments: [],
    taxAnnualClosings: [],
    settlements: [],
    periodSettlements: [],
    settings: {
      companyName,
      ownerName: "",
      ownerAddress: "",
      ownerDocument: "",
      companyEmail: "",
      companyPhone: "",
      website: "",
      supportEmail: "",
      supportPhone: "",
      supportHours: "",
      platformTagline: "",
      documentCity: "",
      documentSignerName: "",
      documentSignerRole: "",
      defaultMessageSignature: "",
      baseCurrency: "PLN",
      utilityVAT: 23,
      lateFee: 50,
      bankAccount: "",
      paymentDueDay: 10,
      reminderDaysBeforeDue: 3,
      reminderDaysBeforeLeaseEnd: 45,
      reminderDaysBeforeDocumentExpiry: 30,
      paymentDemandDays: 7,
      noticePeriodDays: 30,
      ticketResponseLowHours: 24,
      ticketResolutionLowHours: 120,
      ticketResponseMediumHours: 8,
      ticketResolutionMediumHours: 72,
      ticketResponseHighHours: 2,
      ticketResolutionHighHours: 24,
      tenantPortalPaymentsEnabled: true,
      tenantPortalDocumentsEnabled: true,
      tenantPortalTasksEnabled: true,
      tenantPortalMessagesEnabled: true,
      tenantPortalMaintenanceEnabled: true,
      privateRentalTaxPeriod: "monthly",
      privateRentalTaxThresholdMode: "single",
      privateRentalTaxExcludedKeywords: "kaucja, depozyt",
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

function ticketSlaTargets(priority, createdAt, settings = {}) {
  const normalizedPriority = ["niski", "średni", "wysoki"].includes(priority) ? priority : "średni";
  const matrix = {
    niski: {
      responseHours: Number(settings.ticketResponseLowHours || 24),
      resolutionHours: Number(settings.ticketResolutionLowHours || 120)
    },
    "średni": {
      responseHours: Number(settings.ticketResponseMediumHours || 8),
      resolutionHours: Number(settings.ticketResolutionMediumHours || 72)
    },
    wysoki: {
      responseHours: Number(settings.ticketResponseHighHours || 2),
      resolutionHours: Number(settings.ticketResolutionHighHours || 24)
    }
  };
  const selected = matrix[normalizedPriority];
  return {
    responseHours: selected.responseHours,
    resolutionHours: selected.resolutionHours,
    targetResponseAt: addHours(createdAt, selected.responseHours),
    targetResolutionAt: addHours(createdAt, selected.resolutionHours)
  };
}

function normalizeTicket(ticket, settings = {}) {
  const createdAt = asIsoDateTime(ticket?.createdAt) || new Date().toISOString();
  const priority = ["niski", "średni", "wysoki"].includes(ticket?.priority) ? ticket.priority : "średni";
  const status = ["otwarte", "w trakcie", "zamknięte"].includes(ticket?.status) ? ticket.status : "otwarte";
  const defaults = ticketSlaTargets(priority, createdAt, settings);

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
  const updatedAt = asIsoDateTime(message?.updatedAt) || asIsoDateTime(message?.createdAt) || new Date().toISOString();
  return {
    ...message,
    type: ["general", "settlement", "period_settlement"].includes(message?.type) ? message.type : "general",
    subject: sanitizeText(message?.subject || ""),
    status: ["otwarta", "zamknięta"].includes(message?.status) ? message.status : "otwarta",
    priority: ["normalna", "pilna"].includes(message?.priority) ? message.priority : "normalna",
    createdAt: asIsoDateTime(message?.createdAt) || new Date().toISOString(),
    updatedAt,
    lastReadByOwnerAt: asIsoDateTime(message?.lastReadByOwnerAt),
    lastReadByTenantAt: asIsoDateTime(message?.lastReadByTenantAt),
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

function normalizeState(rawState, companyName = "RentHome") {
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
  normalized.settings.paymentDemandDays = Number(normalized.settings.paymentDemandDays || 7);
  normalized.settings.noticePeriodDays = Number(normalized.settings.noticePeriodDays || 30);
  normalized.settings.ticketResponseLowHours = Number(normalized.settings.ticketResponseLowHours || 24);
  normalized.settings.ticketResolutionLowHours = Number(normalized.settings.ticketResolutionLowHours || 120);
  normalized.settings.ticketResponseMediumHours = Number(normalized.settings.ticketResponseMediumHours || 8);
  normalized.settings.ticketResolutionMediumHours = Number(normalized.settings.ticketResolutionMediumHours || 72);
  normalized.settings.ticketResponseHighHours = Number(normalized.settings.ticketResponseHighHours || 2);
  normalized.settings.ticketResolutionHighHours = Number(normalized.settings.ticketResolutionHighHours || 24);
  normalized.settings.tenantPortalPaymentsEnabled = normalized.settings.tenantPortalPaymentsEnabled !== false;
  normalized.settings.tenantPortalDocumentsEnabled = normalized.settings.tenantPortalDocumentsEnabled !== false;
  normalized.settings.tenantPortalTasksEnabled = normalized.settings.tenantPortalTasksEnabled !== false;
  normalized.settings.tenantPortalMessagesEnabled = normalized.settings.tenantPortalMessagesEnabled !== false;
  normalized.settings.tenantPortalMaintenanceEnabled = normalized.settings.tenantPortalMaintenanceEnabled !== false;
  normalized.settings.privateRentalTaxPeriod = ["monthly", "quarterly"].includes(normalized.settings.privateRentalTaxPeriod)
    ? normalized.settings.privateRentalTaxPeriod
    : "monthly";
  normalized.settings.privateRentalTaxThresholdMode = ["single", "spouse_single_settlement"].includes(normalized.settings.privateRentalTaxThresholdMode)
    ? normalized.settings.privateRentalTaxThresholdMode
    : "single";
  normalized.settings.privateRentalTaxExcludedKeywords = sanitizeText(normalized.settings.privateRentalTaxExcludedKeywords || "kaucja, depozyt");
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

  normalized.tickets = normalized.tickets.map((ticket) => normalizeTicket(ticket, normalized.settings));
  normalized.documents = normalized.documents.map(normalizeDocument);
  normalized.messages = normalized.messages.map(normalizeMessage);
  normalized.units = normalized.units.map((unit) => ({
    ...unit,
    taxBookkeepingEnabled: unit?.taxBookkeepingEnabled === true,
    taxBookkeepingStartMonth: sanitizeText(unit?.taxBookkeepingStartMonth || "")
  }));
  normalized.tenants = normalized.tenants.map((tenant) => ({
    ...tenant,
    householdSize: Number(tenant?.householdSize || 1),
    monthlyIncome: Number(tenant?.monthlyIncome || 0),
    moveInTargetDate: sanitizeText(tenant?.moveInTargetDate || ""),
    employmentType: sanitizeText(tenant?.employmentType || ""),
    petsInfo: sanitizeText(tenant?.petsInfo || ""),
    smokingDeclaration: sanitizeText(tenant?.smokingDeclaration || ""),
    guarantorName: sanitizeText(tenant?.guarantorName || ""),
    guarantorPhone: sanitizeText(tenant?.guarantorPhone || ""),
    referencesStatus: sanitizeText(tenant?.referencesStatus || "nie rozpoczęto"),
    idVerificationStatus: sanitizeText(tenant?.idVerificationStatus || "nie rozpoczęto"),
    incomeVerificationStatus: sanitizeText(tenant?.incomeVerificationStatus || "nie rozpoczęto"),
    debtCheckStatus: sanitizeText(tenant?.debtCheckStatus || "nie rozpoczęto"),
    screeningStatus: sanitizeText(tenant?.screeningStatus || "w toku"),
    screeningDecision: sanitizeText(tenant?.screeningDecision || "do decyzji"),
    screeningNotes: sanitizeText(tenant?.screeningNotes || ""),
    starterPacketAutomatedAt: asIsoDateTime(tenant?.starterPacketAutomatedAt)
  }));
  normalized.taxAdjustments = normalized.taxAdjustments.map((entry) => ({
    ...entry,
    date: sanitizeText(entry?.date || ""),
    unitId: sanitizeText(entry?.unitId || ""),
    amount: Number(entry?.amount || 0),
    mode: ["increase", "decrease"].includes(entry?.mode) ? entry.mode : "increase",
    note: sanitizeText(entry?.note || "")
  }));
  normalized.taxPayments = normalized.taxPayments.map((entry) => ({
    ...entry,
    periodKey: sanitizeText(entry?.periodKey || ""),
    paymentDate: sanitizeText(entry?.paymentDate || ""),
    unitId: sanitizeText(entry?.unitId || ""),
    amount: Number(entry?.amount || 0),
    note: sanitizeText(entry?.note || "")
  }));
  normalized.taxAnnualClosings = normalized.taxAnnualClosings.map((entry) => ({
    ...entry,
    id: sanitizeText(entry?.id || ""),
    year: Number(entry?.year || 0),
    unitId: sanitizeText(entry?.unitId || ""),
    scope: ["portfolio", "unit"].includes(entry?.scope) ? entry.scope : "unit",
    acceptedAt: asIsoDateTime(entry?.acceptedAt),
    acceptedBy: sanitizeText(entry?.acceptedBy || ""),
    note: sanitizeText(entry?.note || ""),
    snapshot: {
      taxableRevenue: Number(entry?.snapshot?.taxableRevenue || 0),
      taxDue: Number(entry?.snapshot?.taxDue || 0),
      taxPaid: Number(entry?.snapshot?.taxPaid || 0),
      taxRemaining: Number(entry?.snapshot?.taxRemaining || 0),
      taxableRevenueRounded: Number(entry?.snapshot?.taxableRevenueRounded || 0),
      taxDueRounded: Number(entry?.snapshot?.taxDueRounded || 0),
      taxPaidRounded: Number(entry?.snapshot?.taxPaidRounded || 0),
      taxRemainingRounded: Number(entry?.snapshot?.taxRemainingRounded || 0)
    }
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

  nextState.taxAdjustments = [...state.taxAdjustments];
  nextState.taxPayments = [...state.taxPayments];
  nextState.taxAnnualClosings = state.taxAnnualClosings.filter(
    (entry) => !entry.unitId || unitIds.has(entry.unitId)
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
      taxAdjustments: [],
      taxPayments: [],
      taxAnnualClosings: [],
      settlements: [],
      periodSettlements: [],
      settings: {
        companyName: normalized.settings.companyName || "RentHome",
        ownerName: normalized.settings.ownerName || "",
        ownerAddress: normalized.settings.ownerAddress || "",
        ownerDocument: normalized.settings.ownerDocument || "",
        companyEmail: normalized.settings.companyEmail || "",
        companyPhone: normalized.settings.companyPhone || "",
        website: normalized.settings.website || "",
        supportEmail: normalized.settings.supportEmail || "",
        supportPhone: normalized.settings.supportPhone || "",
        supportHours: normalized.settings.supportHours || "",
        platformTagline: normalized.settings.platformTagline || "",
        documentCity: normalized.settings.documentCity || "",
        documentSignerName: normalized.settings.documentSignerName || "",
        documentSignerRole: normalized.settings.documentSignerRole || "",
        defaultMessageSignature: normalized.settings.defaultMessageSignature || "",
        baseCurrency: normalized.settings.baseCurrency || "PLN",
        bankAccount: normalized.settings.bankAccount || "",
        paymentDueDay: normalized.settings.paymentDueDay || 10,
        reminderDaysBeforeDue: normalized.settings.reminderDaysBeforeDue || 3,
        reminderDaysBeforeLeaseEnd: normalized.settings.reminderDaysBeforeLeaseEnd || 45,
        reminderDaysBeforeDocumentExpiry: normalized.settings.reminderDaysBeforeDocumentExpiry || 30,
        paymentDemandDays: normalized.settings.paymentDemandDays || 7,
        noticePeriodDays: normalized.settings.noticePeriodDays || 30,
        ticketResponseLowHours: normalized.settings.ticketResponseLowHours || 24,
        ticketResolutionLowHours: normalized.settings.ticketResolutionLowHours || 120,
        ticketResponseMediumHours: normalized.settings.ticketResponseMediumHours || 8,
        ticketResolutionMediumHours: normalized.settings.ticketResolutionMediumHours || 72,
        ticketResponseHighHours: normalized.settings.ticketResponseHighHours || 2,
        ticketResolutionHighHours: normalized.settings.ticketResolutionHighHours || 24,
        tenantPortalPaymentsEnabled: normalized.settings.tenantPortalPaymentsEnabled !== false,
        tenantPortalDocumentsEnabled: normalized.settings.tenantPortalDocumentsEnabled !== false,
        tenantPortalTasksEnabled: normalized.settings.tenantPortalTasksEnabled !== false,
        tenantPortalMessagesEnabled: normalized.settings.tenantPortalMessagesEnabled !== false,
        tenantPortalMaintenanceEnabled: normalized.settings.tenantPortalMaintenanceEnabled !== false,
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
    taxAdjustments: [],
    taxPayments: [],
    taxAnnualClosings: [],
    settlements: normalized.settlements.filter((settlement) => settlement.tenantId === tenantId),
    periodSettlements: normalized.periodSettlements.filter((settlement) => settlement.tenantId === tenantId),
    settings: {
      companyName: normalized.settings.companyName || "RentHome",
      ownerName: normalized.settings.ownerName || "",
      ownerAddress: normalized.settings.ownerAddress || "",
      ownerDocument: normalized.settings.ownerDocument || "",
      companyEmail: normalized.settings.companyEmail || "",
      companyPhone: normalized.settings.companyPhone || "",
      website: normalized.settings.website || "",
      supportEmail: normalized.settings.supportEmail || "",
      supportPhone: normalized.settings.supportPhone || "",
      supportHours: normalized.settings.supportHours || "",
      platformTagline: normalized.settings.platformTagline || "",
      documentCity: normalized.settings.documentCity || "",
      documentSignerName: normalized.settings.documentSignerName || "",
      documentSignerRole: normalized.settings.documentSignerRole || "",
      defaultMessageSignature: normalized.settings.defaultMessageSignature || "",
      baseCurrency: normalized.settings.baseCurrency || "PLN",
      bankAccount: normalized.settings.bankAccount || "",
      paymentDueDay: normalized.settings.paymentDueDay || 10,
      reminderDaysBeforeDue: normalized.settings.reminderDaysBeforeDue || 3,
      reminderDaysBeforeLeaseEnd: normalized.settings.reminderDaysBeforeLeaseEnd || 45,
      reminderDaysBeforeDocumentExpiry: normalized.settings.reminderDaysBeforeDocumentExpiry || 30,
      paymentDemandDays: normalized.settings.paymentDemandDays || 7,
      noticePeriodDays: normalized.settings.noticePeriodDays || 30,
      ticketResponseLowHours: normalized.settings.ticketResponseLowHours || 24,
      ticketResolutionLowHours: normalized.settings.ticketResolutionLowHours || 120,
      ticketResponseMediumHours: normalized.settings.ticketResponseMediumHours || 8,
      ticketResolutionMediumHours: normalized.settings.ticketResolutionMediumHours || 72,
      ticketResponseHighHours: normalized.settings.ticketResponseHighHours || 2,
      ticketResolutionHighHours: normalized.settings.ticketResolutionHighHours || 24,
      tenantPortalPaymentsEnabled: normalized.settings.tenantPortalPaymentsEnabled !== false,
      tenantPortalDocumentsEnabled: normalized.settings.tenantPortalDocumentsEnabled !== false,
      tenantPortalTasksEnabled: normalized.settings.tenantPortalTasksEnabled !== false,
      tenantPortalMessagesEnabled: normalized.settings.tenantPortalMessagesEnabled !== false,
      tenantPortalMaintenanceEnabled: normalized.settings.tenantPortalMaintenanceEnabled !== false,
      documentTemplates: {
        ...defaultDocumentTemplates(),
        ...(normalized.settings.documentTemplates || {})
      }
    }
  };
}
