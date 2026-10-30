# Edge deployment

Use the fetch adapter and inject the application provider and session dependencies supported by the host. The Cloudflare example uses a statically imported OpenAI adapter and a consumer-owned KV session store.

Node-only session stores and stdio MCP are unavailable in neutral bundles. Remote named MCP, HTTP and registered client transports are generic framework features. Applications own any context loading and tool implementations. The neutral bundle check verifies absence of Node imports; Ajv requires runtime code generation, so verify host support before choosing a restricted edge runtime.
