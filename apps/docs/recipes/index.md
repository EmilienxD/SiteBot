# Recipes

Complete configs for four common assistants. Each is a whole `chatbot.config.yaml`: copy it, replace
the example company's details, and run `npx sitebot doctor`. A test in the repo validates every config on
these pages against the schema, so they don't drift from what the loader accepts.

| Recipe                                   | Mode  | Shows                                                         |
| ---------------------------------------- | ----- | ------------------------------------------------------------- |
| [Ecommerce assistant](./ecommerce)       | agent | Client tools on your own cart code, stock lookup, product knowledge |
| [Docs assistant](./docs-assistant)       | chat  | Ingest, retrieval on every question, citations                |
| [Lead-capture bot](./lead-capture)       | agent | `fill_form` with approval, lead events to your webhook        |
| [Support triage](./support-triage)       | agent | Signed-in order lookup, ticket creation, handoff to a human   |
