# Discord Member Departure Bot

A standalone Discord bot that records when a member voluntarily leaves, is kicked, or is banned. It posts a formatted embed and keeps a SQLite history.

## Captured information
- Server display name and Discord username
- Discord user ID and avatar
- Account creation date and server join date
- Departure date/time and time spent in the server
- Roles held at the last member snapshot
- Departure type: left, kicked, or banned
- Moderator responsible and moderation reason for kicks/bans, when Discord's audit log provides them
- Linked SteamID as a clickable Steam Community profile link, or "No Steam account linked"

The bot stores snapshots as members join or update and performs an initial member fetch at startup. Historical roles and join dates cannot be reconstructed if the bot was not present and no cached snapshot exists.

## Discord setup
1. Create a separate bot application and invite it with `bot` scope.
2. Enable **Server Members Intent** in the Discord Developer Portal.
3. Give it View Channels, Send Messages, Embed Links, View Audit Log, and Read Message History permissions.
4. Set the environment variables in `.env` or Railway.
5. Run `npm install` and `npm start`.

No Message Content Intent is needed. The bot does not read message content.

## Environment
- `DISCORD_TOKEN`: this bot's token
- `DISCORD_GUILD_ID`: target server ID
- `DEPARTURE_CHANNEL_ID`: channel for departure embeds
- `DATABASE_PATH`: persistent SQLite path (Railway: `/data/departures.sqlite`)
- `STEAM_LINK_LOOKUP_URL`: base URL of the Steam-link bot's read-only lookup endpoint
- `STEAM_LINK_LOOKUP_TOKEN`: shared bearer secret for that endpoint

## Steam-link integration requirement
The Steam-link bot and this bot run as separate Railway services, so they cannot safely assume they share a local SQLite file. Add a read-only endpoint to the existing Steam-link bot that:
- accepts `GET /internal/steam-link/:discordId`
- requires `Authorization: Bearer <STEAM_LINK_LOOKUP_TOKEN>`
- queries the existing `steam_links` table by `discord_id`
- returns `{ "steamId": "17-digit-id" }` when linked, or HTTP 404 when not linked
- never returns sync tokens or any other database fields

Set the same long random `STEAM_LINK_LOOKUP_TOKEN` on both Railway services. Do not expose the endpoint without authentication. Until this endpoint is added and configured, departure notifications will correctly show "No Steam account linked" because the lookup is disabled.

## Important behavior
Discord's member-remove event does not identify whether someone left or was kicked. The bot checks recent audit-log entries and retries briefly. Ban events are separately detected. If Discord does not expose a matching audit entry, the moderator may show as unknown; a kick could be classified as a voluntary leave if the audit entry is unavailable. Keep View Audit Log permission enabled.

SQLite stores one row per departure. Rejoining and leaving again creates another record. The bot suppresses duplicate processing for the same departure event.
