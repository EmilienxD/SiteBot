# SiteBot overview

SiteBot is a reusable embeddable assistant framework. A consuming website owns trusted instructions, context loading, provider configuration, and the definition and implementation of every application tool.

The framework supplies a bounded model loop, validated tool execution, streaming, conversation storage, permission and approval gates, transport adapters, localization, and generic source provenance and citations. An empty tool registry exposes no tools. Models supply tool names and arguments; they never supply executable code.

English and French are supported. Applications can add language catalogs and locale-specific UI copy. The server resolves the locale and passes it to trusted prompt resolvers and tool handlers.

Retrieval, document discovery or reading, crawling, ingestion, embeddings, reranking, and product actions belong to consuming applications. SiteBot ships no first-party implementation of those capabilities.

Read [architecture](01-architecture.md), [configuration](02-configuration.md), [protocol](03-protocol.md), [providers and engine](04-providers-and-engine.md), [tools](05-tools.md), [sources](06-sources.md), [widget](07-widget.md), and [security](08-security.md).
