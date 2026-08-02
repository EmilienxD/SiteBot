import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Support — Northwind Logistics',
  description: 'Contact routes, SLAs, and how to escalate a stuck shipment.',
}

export default function SupportPage() {
  return (
    <main>
      <h1>Support</h1>
      <p className="lede">
        Support hours are 09:00–18:00 CET, Monday to Friday. Anything involving a container that is
        already accruing demurrage is treated as urgent regardless of plan.
      </p>

      <h2>How to reach us</h2>
      <table>
        <thead>
          <tr>
            <th>Route</th>
            <th>Use it for</th>
            <th>First response</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>support@northwind.example.com</td>
            <td>Anything not time-critical</td>
            <td>Next business day (Starter), 4 working hours (Growth)</td>
          </tr>
          <tr>
            <td>Dashboard chat</td>
            <td>Questions about a specific shipment</td>
            <td>Within the hour during support hours</td>
          </tr>
          <tr>
            <td>Escalation line</td>
            <td>Held cargo, missed sailings, demurrage risk</td>
            <td>Immediate, 24/7 on Enterprise</td>
          </tr>
        </tbody>
      </table>

      <h2>Escalating a stuck shipment</h2>
      <ol>
        <li>
          Find the booking reference — it starts with <code>NW-</code>.
        </li>
        <li>
          Check the shipment timeline for a <code>customs.held</code> event and the reason code.
        </li>
        <li>
          Reply on the existing shipment thread rather than opening a new one, so the customs desk
          has the history.
        </li>
        <li>
          If free days expire within 48 hours, mark the thread urgent. That routes it to the on-call
          broker instead of the queue.
        </li>
      </ol>

      <h2>Common questions</h2>

      <h3>Why was my entry held?</h3>
      <p>
        Usually a classification query: customs disagrees with the HS code, or the commercial
        invoice value does not match the declared one. The reason code on the{' '}
        <code>customs.held</code> event tells you which.
      </p>

      <h3>Who pays demurrage?</h3>
      <p>
        The importer, passed through at cost. We alert you three days before free days expire, and
        again on the last day.
      </p>

      <h3>Can I change the destination after booking?</h3>
      <p>
        Before departure, usually yes, at the carrier&apos;s amendment fee. After departure it
        depends on the lane and is rarely cheap — ask before assuming.
      </p>

      <h3>Do you handle dangerous goods?</h3>
      <p>
        Classes 3, 8 and 9 on most ocean lanes with advance notice. Not class 1 or 7. Air freight DG
        is case by case.
      </p>
    </main>
  )
}
