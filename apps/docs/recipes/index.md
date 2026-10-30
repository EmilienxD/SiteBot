# Recipes

Complete configs for four common assistants. Each is a whole `chatbot.config.yaml`: copy it, replace
the example company's details, and run `npx sitebot doctor`. A test in the repo validates every config on
these pages against the schema, so they don't drift from what the loader accepts.

Applications own context loading and every tool implementation. Use complete explicit handlers or transports; an empty registry exposes no tools. See [the tool contract](https://github.com/EmilienxD/SiteBot/blob/main/docs/05-tools.md).
