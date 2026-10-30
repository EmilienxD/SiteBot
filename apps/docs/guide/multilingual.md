# Languages

English and French ship with the framework. Set `ui.locale` to a supported locale or `auto`, and declare `ui.supportedLocales`. Add translations and string catalogs for another language. Server locale resolution validates the requested locale and falls back to configured defaults.

Prompt resolvers and application tool handlers receive the resolved locale. Applications own translated instructions, context selection and source-language preferences. `ctx.sources.register` accepts an optional `lang`; source provenance preserves original URLs and language while answers can use the visitor's language.

The widget localizes controls, errors, approvals and accessible citation labels. Per-request locale does not mutate shared configuration or leak into a shared cached public config. Application text stays untrusted reference data in every language.
