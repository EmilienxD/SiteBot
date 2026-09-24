// The plain-html example, exactly as shipped, with two changes for the browser
// tests: a scripted offline model instead of a provider, and memory storage so
// every run starts clean. Everything else — tools, approval policy, UI — is
// inherited, so the tests exercise the example a visitor would see.
export default {
  extends: '../examples/plain-html/chatbot.config.yaml',
  backend: {
    provider: 'custom',
    model: 'scripted',
    module: './fixtures/scripted-model.mjs#createModel',
    maxRetries: 0,
  },
  storage: { type: 'memory' },
  security: {
    // Tests share one IP and send far more than a visitor would.
    rateLimit: { perSession: '1000/5m', perIp: '10000/1h' },
  },
}
