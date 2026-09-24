// examples/nextjs with the scripted offline model — used by the CI smoke job
// via SITEBOT_CONFIG. Everything else is the example as shipped.
export default {
  extends: '../../examples/nextjs/chatbot.config.yaml',
  backend: {
    provider: 'custom',
    model: 'scripted',
    module: '../../e2e/fixtures/scripted-model.mjs#createModel',
  },
}
