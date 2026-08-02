export default function HomePage() {
  return (
    <main>
      <h1>Freight that clears customs the first time</h1>
      <p className="lede">
        Northwind Logistics moves ocean and air freight for mid-market importers, and handles the
        customs paperwork that usually holds it up. One broker, one API, one invoice.
      </p>

      <h2>What we do</h2>
      <p>
        We book capacity with carriers, consolidate your shipments where it saves money, and file
        entry documents with customs on your behalf. Most customers come to us after a broker
        misclassified something and a container sat on a quay for eleven days.
      </p>

      <div className="cards">
        <div className="card">
          <h3>Ocean freight</h3>
          <p>
            FCL and LCL from 40 origin ports. Weekly departures on the main Asia–Europe and
            transpacific lanes.
          </p>
        </div>
        <div className="card">
          <h3>Air freight</h3>
          <p>
            Consolidated and direct, with next-flight-out for anything that has already gone wrong
            somewhere else.
          </p>
        </div>
        <div className="card">
          <h3>Customs brokerage</h3>
          <p>
            HS classification, entry filing and duty calculation. Included in every plan at no extra
            cost.
          </p>
        </div>
      </div>

      <h2>How it works</h2>
      <ol>
        <li>
          Send us a quote request with origin, destination, Incoterms and cargo details. Quotes are
          valid for 30 days.
        </li>
        <li>Accept the quote and we book the space. You get a booking reference immediately.</li>
        <li>
          Track the shipment in the dashboard or over the API. Milestone webhooks fire on departure,
          arrival, customs release and delivery.
        </li>
        <li>We file the customs entry and pay duty on your behalf, then invoice monthly.</li>
      </ol>

      <h2>Why importers switch</h2>
      <table>
        <thead>
          <tr>
            <th>Problem</th>
            <th>What we do about it</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Customs delays from bad HS classification</td>
            <td>Licensed brokers classify every line, and we carry the liability</td>
          </tr>
          <tr>
            <td>No visibility between booking and arrival</td>
            <td>Milestone webhooks and a shipments API, not a weekly spreadsheet</td>
          </tr>
          <tr>
            <td>Surprise fees on the invoice</td>
            <td>All-in per-shipment pricing; demurrage is the only pass-through</td>
          </tr>
        </tbody>
      </table>

      <p>
        See <a href="/pricing">pricing</a>, read the <a href="/docs">API documentation</a>, or{' '}
        <a href="/support">talk to support</a>.
      </p>
    </main>
  )
}
