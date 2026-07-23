> [中文文档](./docs/README.zh.md) · English

# pi-wishlist

Pi package wishlist — track packages you're interested in but not ready to install,
with automatic notifications on new versions or activity.

## Installation

```bash
pi install pi-wishlist
```

For multi-language support, also install the i18n SDK:

```bash
pi install npm:@juicesharp/rpiv-i18n
```

After installation, use `/languages` to switch between available locales.
When the i18n SDK is not installed, wishlist displays in English.

## Usage

### In Pi conversation

```
/wish             Open TUI wishlist
/wish add <name>   Add a package to the wishlist
/wish list         List wishlist
/wish remove <name> Remove a package
/wish refresh      Force check for updates
/wish stats <name> View detailed statistics
```

## Features

- **Event-driven notifications** — auto-push on new releases / GitHub activity
- **Daily auto-check** — async check on session_start, non-blocking
- **npm ↔ GitHub auto-linking** — just enter npm package name, GitHub data auto-fetched
- **Auto-remove installed packages** — auto-removed from wishlist when installed
- **Deduplicated notifications** — each event notified only once
- **TUI modal interface** — `/wish` opens an interactive wishlist
- **i18n ready** — optional `@juicesharp/rpiv-i18n` for locale switching

## Data Storage

`~/.pi/agent/data/wishlist/wishlist.json`

## License

MIT