import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'API documentation — Northwind Logistics',
  description: 'Integration guide for the shipments API and webhooks.',
}

export default function DocsPage() {
  return (
    <main>
      <h1>Shipments API</h1>
      <p className="lede">
        Book, track and reconcile shipments programmatically. Available on Growth and Enterprise
        plans.
      </p>

      <h2>Authentication</h2>
      <p>
        Every request carries a bearer token issued from the dashboard. Tokens are scoped to one
        account and can be restricted to read-only.
      </p>
      <pre>
        <code>{`curl https://api.northwind.example.com/v1/shipments \\
  -H "Authorization: Bearer nw_live_..."`}</code>
      </pre>

      <h2>Creating a shipment</h2>
      <p>
        A shipment starts from an accepted quote. Post the quote id and the cargo lines; the
        response carries the booking reference you will use everywhere else.
      </p>
      <pre>
        <code>{`POST /v1/shipments
{
  "quoteId": "qt_8841",
  "incoterm": "FOB",
  "lines": [
    { "description": "Ceramic tiles", "hsCode": "6907.21", "pieces": 480, "kg": 9200 }
  ]
}`}</code>
      </pre>

      <h2>Webhooks</h2>
      <p>
        Register one endpoint per environment. We deliver each event at least once and retry with
        exponential backoff for 24 hours; treat delivery as idempotent and key on{' '}
        <code>event.id</code>.
      </p>
      <table>
        <thead>
          <tr>
            <th>Event</th>
            <th>Fires when</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>shipment.departed</code>
            </td>
            <td>The vessel or aircraft leaves the origin port</td>
          </tr>
          <tr>
            <td>
              <code>shipment.arrived</code>
            </td>
            <td>Arrival is confirmed at the destination port</td>
          </tr>
          <tr>
            <td>
              <code>customs.released</code>
            </td>
            <td>Customs clears the entry and the cargo can move</td>
          </tr>
          <tr>
            <td>
              <code>customs.held</code>
            </td>
            <td>Customs flags the entry for examination or query</td>
          </tr>
          <tr>
            <td>
              <code>shipment.delivered</code>
            </td>
            <td>Proof of delivery is recorded</td>
          </tr>
        </tbody>
      </table>

      <h3>Verifying a webhook</h3>
      <p>
        Each delivery carries an <code>X-Northwind-Signature</code> header: an HMAC-SHA256 of the
        raw body using your endpoint secret. Compare it in constant time, and reject deliveries
        whose timestamp is more than five minutes old.
      </p>

      <h2>Rate limits</h2>
      <p>
        600 requests per minute per token. Exceeding it returns <code>429</code> with a{' '}
        <code>Retry-After</code> header. Bulk exports should use the reporting endpoints rather
        than paginating the shipments list.
      </p>

      <h2>Errors</h2>
      <p>
        Errors are JSON with a stable <code>code</code>, a human <code>message</code>, and a{' '}
        <code>requestId</code> to quote at support. A <code>422</code> means the cargo lines failed
        validation — most often an HS code that does not exist for the destination country.
      </p>
    </main>
  )
}
