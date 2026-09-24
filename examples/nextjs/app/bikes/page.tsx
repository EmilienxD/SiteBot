export const metadata = { title: 'Bikes — Lumen Bikes' }

const bikes = [
  {
    name: 'Lumen City',
    range: '70 km',
    weight: '21 kg',
    price: '€2,299',
    note: 'Upright, belt drive, hub gears. Our commuter bike.',
  },
  {
    name: 'Lumen Cargo',
    range: '55 km',
    weight: '34 kg',
    price: '€3,890',
    note: 'Front box for two children or 80 kg of shopping.',
  },
  {
    name: 'Lumen Fold',
    range: '45 km',
    weight: '17 kg',
    price: '€2,650',
    note: 'Folds in ten seconds to fit on the train.',
  },
]

export default function Bikes() {
  return (
    <>
      <h1>Our bikes</h1>
      <p>All three have a 500 Wh battery, hydraulic disc brakes and integrated lights.</p>
      {bikes.map((bike) => (
        <section key={bike.name} id={bike.name.toLowerCase().replace(' ', '-')}>
          <h2>{bike.name}</h2>
          <p>{bike.note}</p>
          <p>
            Range {bike.range} · {bike.weight} · {bike.price}
          </p>
        </section>
      ))}
    </>
  )
}
