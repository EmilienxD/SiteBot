import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Pricing — Northwind Logistics',
  description: 'Plans, per-shipment pricing, and what each tier includes.',
}

export default function PricingPage() {
  return (
    <main>
      <h1>Pricing</h1>
      <p className="lede">
        A monthly platform fee plus a flat per-shipment rate. Customs brokerage is included in every
        plan — we do not charge separately for entry filing.
      </p>

      <div className="cards">
        <div className="card">
          <h3>Starter</h3>
          <p className="price">
            €290<span style={{ fontSize: '1rem', fontWeight: 400 }}>/mo</span>
          </p>
          <p style={{ color: 'var(--muted)', fontSize: '0.9375rem' }}>€45 per shipment</p>
          <ul>
            <li>Up to 25 shipments a month</li>
            <li>Customs entry filing included</li>
            <li>Dashboard tracking</li>
            <li>Email support, next business day</li>
          </ul>
        </div>
        <div className="card">
          <h3>Growth</h3>
          <p className="price">
            €890<span style={{ fontSize: '1rem', fontWeight: 400 }}>/mo</span>
          </p>
          <p style={{ color: 'var(--muted)', fontSize: '0.9375rem' }}>€32 per shipment</p>
          <ul>
            <li>Up to 150 shipments a month</li>
            <li>Everything in Starter</li>
            <li>Shipments API and webhooks</li>
            <li>Named account manager</li>
            <li>Support response within 4 working hours</li>
          </ul>
        </div>
        <div className="card">
          <h3>Enterprise</h3>
          <p className="price">Custom</p>
          <p style={{ color: 'var(--muted)', fontSize: '0.9375rem' }}>Volume rates</p>
          <ul>
            <li>Unlimited shipments</li>
            <li>Everything in Growth</li>
            <li>Dedicated customs desk</li>
            <li>Custom SLAs and 24/7 escalation</li>
            <li>SSO and audit logging</li>
          </ul>
        </div>
      </div>

      <h2>What counts as a shipment</h2>
      <p>
        One shipment is one booking reference, however many containers or packages it contains. A
        consolidated LCL booking with four suppliers on one bill of lading is one shipment, not
        four.
      </p>

      <h2>What is not included</h2>
      <ul>
        <li>
          <strong>Duty and VAT.</strong> Passed through at cost. We pay on your behalf and invoice
          monthly.
        </li>
        <li>
          <strong>Demurrage and detention.</strong> Charged by the carrier when a container sits
          past its free days. We warn you before it starts accruing.
        </li>
        <li>
          <strong>Inspection fees.</strong> When customs pulls a container for examination, the port
          charges for it.
        </li>
      </ul>

      <h2>Billing</h2>
      <p>
        Monthly, in arrears, net 30. Annual prepayment saves 12%. Quotes for individual shipments
        are valid for 30 days from issue; after that the carrier rate has usually moved.
      </p>

      <h2>Changing plans</h2>
      <p>
        Upgrade at any time and the platform fee is prorated. Downgrades take effect at the next
        billing period. There is no minimum term on Starter or Growth.
      </p>
    </main>
  )
}
