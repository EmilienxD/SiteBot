// The plain-html example exactly as shipped — real provider from
// SITEBOT_PROVIDER / SITEBOT_MODEL — with memory storage so every run starts
// clean, and a rate limit a test run cannot trip.
export default {
  extends: '../../examples/plain-html/chatbot.config.yaml',
  storage: { type: 'memory' },
  security: {
    rateLimit: { perSession: '1000/5m', perIp: '10000/1h' },
  },
}
