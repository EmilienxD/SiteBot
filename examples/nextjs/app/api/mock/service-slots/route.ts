// Stands in for a workshop booking API, so the `find_service_slots` tool in
// chatbot.config.yaml has something to call. Deterministic: weekdays have
// three slots, one taken on odd dates; the workshop is closed at weekends.
export const dynamic = 'force-dynamic'

export function GET(request: Request): Response {
  const date = new URL(request.url).searchParams.get('date') ?? ''
  const day = new Date(`${date}T12:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(day.getTime()))
    return Response.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 })
  const weekday = day.getUTCDay()
  if (weekday === 0 || weekday === 6) return Response.json({ date, open: false, slots: [] })
  const slots = ['09:00', '11:30', '14:00'].filter(
    (_, index) => !(day.getUTCDate() % 2 === 1 && index === 1),
  )
  return Response.json({ date, open: true, slots, durationMinutes: 90, priceEur: 79 })
}
