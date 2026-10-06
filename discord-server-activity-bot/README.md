# Discord Server Activity Bot

Tracks **activity inside your Discord server only**. Being online on Discord does not count as server activity.

## Tracks
- Messages and message channel
- Voice join/leave/switch and channel
- Slash-command use
- Server joins
- Last overall server activity

## Commands
- `/activity [user]` — detailed activity for a member
- `/recent [limit]` — most recently active members
- `/inactive [days] [limit]` — members inactive for the selected period

The database stores timestamps and event/channel metadata, not message contents.

## Setup
1. Create a Discord bot and copy its token.
2. Copy your server ID.
3. Rename `.env.example` to `.env` and fill it in.
4. Run `npm install`, then `npm start`.
5. Enable **Server Members Intent** and **Message Content Intent** in the Discord Developer Portal.
6. Invite the bot with `bot` and `applications.commands` scopes.

Recommended permissions: View Channels, Send Messages, Embed Links. Administrator is not required.

Historical voice activity from before the bot was running cannot be reconstructed. Existing message history can be backfilled later if desired.
