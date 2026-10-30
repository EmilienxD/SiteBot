# SiteBot deployment checklist

Run `sitebot doctor --production` before exposing the endpoint publicly.

Applications own context loading and every tool implementation. Use complete explicit handlers or transports; an empty registry exposes no tools. See [the tool contract](https://github.com/EmilienxD/SiteBot/blob/main/docs/05-tools.md).
