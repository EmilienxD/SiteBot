/**
 * The prose of `apps/playground` (Northwind Logistics), sectioned the way the
 * heading chunker would section it — one entry per `<h2>`/`<h3>` run.
 *
 * It is a copy rather than a scrape on purpose: the golden retrieval set in
 * `knowledge/golden-retrieval.test.ts` must fail when *retrieval* regresses,
 * not when someone edits a paragraph in the playground. Refresh it
 * deliberately, and re-check the golden pairs when you do.
 */

export interface CorpusSection {
  /** `<page>#<section>` — the golden set's expected-document key. */
  id: string
  url: string
  title: string
  headingPath: string[]
  text: string
}

export const PLAYGROUND_CORPUS: readonly CorpusSection[] = [
  // ── / ─────────────────────────────────────────────────────────────────────
  {
    id: 'home#intro',
    url: 'https://northwind.example.com/',
    title: 'Freight that clears customs the first time',
    headingPath: ['Freight that clears customs the first time'],
    text: `Northwind Logistics moves ocean and air freight for mid-market importers, and handles the customs paperwork that usually holds it up. One broker, one API, one invoice. We book capacity with carriers, consolidate your shipments where it saves money, and file entry documents with customs on your behalf. Most customers come to us after a broker misclassified something and a container sat on a quay for eleven days.`,
  },
  {
    id: 'home#services',
    url: 'https://northwind.example.com/',
    title: 'Freight that clears customs the first time',
    headingPath: ['Freight that clears customs the first time', 'What we do'],
    text: `Ocean freight: FCL and LCL from 40 origin ports. Weekly departures on the main Asia–Europe and transpacific lanes. Air freight: consolidated and direct, with next-flight-out for anything that has already gone wrong somewhere else. Customs brokerage: HS classification, entry filing and duty calculation. Included in every plan at no extra cost.`,
  },
  {
    id: 'home#how-it-works',
    url: 'https://northwind.example.com/',
    title: 'Freight that clears customs the first time',
    headingPath: ['Freight that clears customs the first time', 'How it works'],
    text: `Send us a quote request with origin, destination, Incoterms and cargo details. Quotes are valid for 30 days. Accept the quote and we book the space. You get a booking reference immediately. Track the shipment in the dashboard or over the API. Milestone webhooks fire on departure, arrival, customs release and delivery. We file the customs entry and pay duty on your behalf, then invoice monthly.`,
  },
  {
    id: 'home#why-switch',
    url: 'https://northwind.example.com/',
    title: 'Freight that clears customs the first time',
    headingPath: ['Freight that clears customs the first time', 'Why importers switch'],
    text: `Customs delays from bad HS classification: licensed brokers classify every line, and we carry the liability. No visibility between booking and arrival: milestone webhooks and a shipments API, not a weekly spreadsheet. Surprise fees on the invoice: all-in per-shipment pricing; demurrage is the only pass-through.`,
  },

  // ── /docs ─────────────────────────────────────────────────────────────────
  {
    id: 'docs#intro',
    url: 'https://northwind.example.com/docs',
    title: 'API documentation — Northwind Logistics',
    headingPath: ['Shipments API'],
    text: `Book, track and reconcile shipments programmatically. Available on Growth and Enterprise plans.`,
  },
  {
    id: 'docs#authentication',
    url: 'https://northwind.example.com/docs',
    title: 'API documentation — Northwind Logistics',
    headingPath: ['Shipments API', 'Authentication'],
    text: `Every request carries a bearer token issued from the dashboard. Tokens are scoped to one account and can be restricted to read-only. curl https://api.northwind.example.com/v1/shipments -H "Authorization: Bearer nw_live_..."`,
  },
  {
    id: 'docs#creating-a-shipment',
    url: 'https://northwind.example.com/docs',
    title: 'API documentation — Northwind Logistics',
    headingPath: ['Shipments API', 'Creating a shipment'],
    text: `A shipment starts from an accepted quote. Post the quote id and the cargo lines; the response carries the booking reference you will use everywhere else. POST /v1/shipments with quoteId, incoterm and lines describing each cargo line, its hsCode, pieces and kg.`,
  },
  {
    id: 'docs#webhooks',
    url: 'https://northwind.example.com/docs',
    title: 'API documentation — Northwind Logistics',
    headingPath: ['Shipments API', 'Webhooks'],
    text: `Register one endpoint per environment. We deliver each event at least once and retry with exponential backoff for 24 hours; treat delivery as idempotent and key on event.id. Events: shipment.departed fires when the vessel or aircraft leaves the origin port. shipment.arrived fires when arrival is confirmed at the destination port. customs.released fires when customs clears the entry and the cargo can move. customs.held fires when customs flags the entry for examination or query. shipment.delivered fires when proof of delivery is recorded.`,
  },
  {
    id: 'docs#verifying-a-webhook',
    url: 'https://northwind.example.com/docs',
    title: 'API documentation — Northwind Logistics',
    headingPath: ['Shipments API', 'Webhooks', 'Verifying a webhook'],
    text: `Each delivery carries an X-Northwind-Signature header: an HMAC-SHA256 of the raw body using your endpoint secret. Compare it in constant time, and reject deliveries whose timestamp is more than five minutes old.`,
  },
  {
    id: 'docs#rate-limits',
    url: 'https://northwind.example.com/docs',
    title: 'API documentation — Northwind Logistics',
    headingPath: ['Shipments API', 'Rate limits'],
    text: `600 requests per minute per token. Exceeding it returns 429 with a Retry-After header. Bulk exports should use the reporting endpoints rather than paginating the shipments list.`,
  },
  {
    id: 'docs#errors',
    url: 'https://northwind.example.com/docs',
    title: 'API documentation — Northwind Logistics',
    headingPath: ['Shipments API', 'Errors'],
    text: `Errors are JSON with a stable code, a human message, and a requestId to quote at support. A 422 means the cargo lines failed validation — most often an HS code that does not exist for the destination country.`,
  },

  // ── /pricing ──────────────────────────────────────────────────────────────
  {
    id: 'pricing#intro',
    url: 'https://northwind.example.com/pricing',
    title: 'Pricing — Northwind Logistics',
    headingPath: ['Pricing'],
    text: `A monthly platform fee plus a flat per-shipment rate. Customs brokerage is included in every plan — we do not charge separately for entry filing.`,
  },
  {
    id: 'pricing#plans',
    url: 'https://northwind.example.com/pricing',
    title: 'Pricing — Northwind Logistics',
    headingPath: ['Pricing', 'Plans'],
    text: `Starter: €290/mo, €45 per shipment. Up to 25 shipments a month, customs entry filing included, dashboard tracking, email support next business day. Growth: €890/mo, €32 per shipment. Up to 150 shipments a month, everything in Starter, shipments API and webhooks, named account manager, support response within 4 working hours. Enterprise: custom volume rates. Unlimited shipments, everything in Growth, dedicated customs desk, custom SLAs and 24/7 escalation, SSO and audit logging.`,
  },
  {
    id: 'pricing#what-counts',
    url: 'https://northwind.example.com/pricing',
    title: 'Pricing — Northwind Logistics',
    headingPath: ['Pricing', 'What counts as a shipment'],
    text: `One shipment is one booking reference, however many containers or packages it contains. A consolidated LCL booking with four suppliers on one bill of lading is one shipment, not four.`,
  },
  {
    id: 'pricing#not-included',
    url: 'https://northwind.example.com/pricing',
    title: 'Pricing — Northwind Logistics',
    headingPath: ['Pricing', 'What is not included'],
    text: `Duty and VAT are passed through at cost. We pay on your behalf and invoice monthly. Demurrage and detention are charged by the carrier when a container sits past its free days. We warn you before it starts accruing. Inspection fees: when customs pulls a container for examination, the port charges for it.`,
  },
  {
    id: 'pricing#billing',
    url: 'https://northwind.example.com/pricing',
    title: 'Pricing — Northwind Logistics',
    headingPath: ['Pricing', 'Billing'],
    text: `Monthly, in arrears, net 30. Annual prepayment saves 12%. Quotes for individual shipments are valid for 30 days from issue; after that the carrier rate has usually moved.`,
  },
  {
    id: 'pricing#changing-plans',
    url: 'https://northwind.example.com/pricing',
    title: 'Pricing — Northwind Logistics',
    headingPath: ['Pricing', 'Changing plans'],
    text: `Upgrade at any time and the platform fee is prorated. Downgrades take effect at the next billing period. There is no minimum term on Starter or Growth.`,
  },

  // ── /support ──────────────────────────────────────────────────────────────
  {
    id: 'support#intro',
    url: 'https://northwind.example.com/support',
    title: 'Support — Northwind Logistics',
    headingPath: ['Support'],
    text: `Support hours are 09:00–18:00 CET, Monday to Friday. Anything involving a container that is already accruing demurrage is treated as urgent regardless of plan.`,
  },
  {
    id: 'support#how-to-reach-us',
    url: 'https://northwind.example.com/support',
    title: 'Support — Northwind Logistics',
    headingPath: ['Support', 'How to reach us'],
    text: `support@northwind.example.com for anything not time-critical: first response next business day on Starter, 4 working hours on Growth. Dashboard chat for questions about a specific shipment: within the hour during support hours. Escalation line for held cargo, missed sailings and demurrage risk: immediate, 24/7 on Enterprise.`,
  },
  {
    id: 'support#escalating',
    url: 'https://northwind.example.com/support',
    title: 'Support — Northwind Logistics',
    headingPath: ['Support', 'Escalating a stuck shipment'],
    text: `Find the booking reference — it starts with NW-. Check the shipment timeline for a customs.held event and the reason code. Reply on the existing shipment thread rather than opening a new one, so the customs desk has the history. If free days expire within 48 hours, mark the thread urgent. That routes it to the on-call broker instead of the queue.`,
  },
  {
    id: 'support#why-held',
    url: 'https://northwind.example.com/support',
    title: 'Support — Northwind Logistics',
    headingPath: ['Support', 'Common questions', 'Why was my entry held?'],
    text: `Usually a classification query: customs disagrees with the HS code, or the commercial invoice value does not match the declared one. The reason code on the customs.held event tells you which.`,
  },
  {
    id: 'support#demurrage',
    url: 'https://northwind.example.com/support',
    title: 'Support — Northwind Logistics',
    headingPath: ['Support', 'Common questions', 'Who pays demurrage?'],
    text: `The importer, passed through at cost. We alert you three days before free days expire, and again on the last day.`,
  },
  {
    id: 'support#change-destination',
    url: 'https://northwind.example.com/support',
    title: 'Support — Northwind Logistics',
    headingPath: ['Support', 'Common questions', 'Can I change the destination after booking?'],
    text: `Before departure, usually yes, at the carrier's amendment fee. After departure it depends on the lane and is rarely cheap — ask before assuming.`,
  },
  {
    id: 'support#dangerous-goods',
    url: 'https://northwind.example.com/support',
    title: 'Support — Northwind Logistics',
    headingPath: ['Support', 'Common questions', 'Do you handle dangerous goods?'],
    text: `Classes 3, 8 and 9 on most ocean lanes with advance notice. Not class 1 or 7. Air freight DG is case by case.`,
  },
]
