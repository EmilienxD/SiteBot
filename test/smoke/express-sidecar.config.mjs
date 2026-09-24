// examples/express-sidecar with the scripted offline model — used by the CI
// smoke job via SITEBOT_CONFIG.
export default {
  extends: '../../examples/express-sidecar/chatbot.config.yaml',
  backend: {
    provider: 'custom',
    model: 'scripted',
    module: '../../e2e/fixtures/scripted-model.mjs#createModel',
  },
}
