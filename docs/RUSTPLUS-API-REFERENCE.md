# Rust+ API / Protocol Reference

**Project:** Rust API Explorer  
**Purpose:** Reference for a local Rust+ data explorer that connects to the Rust Companion Server and records supported requests, responses, and live broadcasts.

> **Status note:** Rust+ is a protocol rather than a conventional REST API. The structures below are based on the current community-maintained `rustplus.proto` definition and Facepunch's Companion Server documentation. A field existing in the protobuf does **not** guarantee that a current server will populate it. Vending-machine/event marker availability has changed over time and should be tested against a live server.

## 1. Connection and authentication

The Rust Companion Server is the server-side service used by Rust+.

- Transport: TCP/WebSocket-based Companion Server connection.
- Default companion port: game port + 67, or RCON port + 67, whichever is larger.
- With unchanged standard ports, the common companion port is `28082`.
- Server admins can use `app.info` to see the companion port.
- `app.port` can change it; Facepunch documents that the port must be 10000 or higher for the Rust+ backend.

Every `AppRequest` contains:

| Field | Type | Purpose |
|---|---|---|
| `seq` | uint32 | Request sequence number |
| `playerId` | uint64 | Authenticated Rust player SteamID |
| `playerToken` | int32 | Rust+ player token |
| `entityId` | uint32 | Entity ID for entity-specific requests |

Do not store Steam passwords, Steam session cookies, or unrelated Steam credentials.

## 2. Complete request map

| Request | Input | Response | Purpose |
|---|---|---|---|
| `getInfo` | none | `AppInfo` | Server information |
| `getTime` | none | `AppTime` | Rust world time |
| `getMap` | none | `AppMap` | Map image and monuments |
| `getTeamInfo` | none | `AppTeamInfo` | Team members/status/positions |
| `getTeamChat` | none | `AppTeamChat` | Team chat history |
| `sendTeamMessage` | message | success/error | Send team chat |
| `getEntityInfo` | entity ID | `AppEntityInfo` | Read smart entity |
| `setEntityValue` | entity + bool | success/error | Change supported entity state |
| `checkSubscription` | none | `AppFlag` | Check subscription |
| `setSubscription` | bool | success/error/flag | Change subscription |
| `getMapMarkers` | none | `AppMapMarkers` | Map markers |
| `promoteToLeader` | SteamID | success/error | Promote team member |
| `getClanInfo` | none | `AppClanInfo` | Clan information |
| `setClanMotd` | message | success/error | Set clan MOTD |
| `getClanChat` | none | `AppClanChat` | Clan chat |
| `sendClanMessage` | message | success/error | Send clan chat |
| `getNexusAuth` | app key | `AppNexusAuth` | Nexus authentication |
| `cameraSubscribe` | camera ID | `AppCameraInfo` | Subscribe to camera |
| `cameraUnsubscribe` | none | success/error | Stop camera subscription |
| `cameraInput` | buttons + mouse delta | camera broadcast | Control subscribed camera |

## 3. getInfo — server information

`AppInfo` fields:

| Field | Type | Description |
|---|---|---|
| `name` | string | Server name |
| `headerImage` | string | Header image |
| `url` | string | Server URL |
| `map` | string | Map name |
| `mapSize` | uint32 | Map size |
| `wipeTime` | uint32 | Wipe timestamp |
| `players` | uint32 | Current players |
| `maxPlayers` | uint32 | Maximum players |
| `queuedPlayers` | uint32 | Queue |
| `seed` | uint32? | Map seed |
| `salt` | uint32? | Map salt |
| `logoImage` | string? | Server logo |
| `nexus` | string? | Nexus information |
| `nexusId` | int32? | Nexus ID |
| `nexusZone` | string? | Nexus zone |

## 4. getTime — Rust world clock

`AppTime`:

- `dayLengthMinutes` — Rust day length
- `timeScale` — time scale
- `sunrise` — sunrise
- `sunset` — sunset
- `time` — current Rust time

## 5. getMap — map and monuments

`AppMap`:

- `width`
- `height`
- `jpgImage` — JPEG map bytes
- `oceanMargin`
- `monuments[]`
- optional `background`

Each monument contains `token`, `x`, and `y`.

## 6. getTeamInfo — team data

Top-level:

- `leaderSteamId`
- `members[]`
- `mapNotes[]`
- `leaderMapNotes[]`

Each member:

- `steamId`
- `name`
- `x`, `y`
- `isOnline`
- `spawnTime`
- `isAlive`
- `deathTime`

This is one of the most useful real-time data sources available to a normal player.

## 7. Team chat

`getTeamChat` returns messages containing:

- SteamID
- Name
- Message
- Color
- Timestamp

`sendTeamMessage` accepts a message string and sends it to team chat.

## 8. Smart entities

Entity types currently defined:

- `Switch`
- `Alarm`
- `StorageMonitor`

`getEntityInfo` returns:

| Field | Type | Meaning |
|---|---|---|
| `value` | bool? | On/off-style state |
| `items` | array | Storage monitor items |
| `capacity` | int32? | Storage capacity |
| `hasProtection` | bool? | Protection state |
| `protectionExpiry` | uint32? | Protection expiry |

Storage items contain:

- `itemId`
- `quantity`
- `itemIsBlueprint`

`setEntityValue` accepts an entity ID and boolean value for supported entities.

## 9. Entity live updates

The protocol defines an `entityChanged` broadcast:

```
AppBroadcast
└── entityChanged
    ├── entityId
    └── payload
```

Recommended implementation:

1. Request/register the entity.
2. Cache its state.
3. Listen for broadcasts.
4. Update the UI immediately.
5. Optionally save timestamped history.

## 10. Map markers

`getMapMarkers` returns `AppMapMarkers`.

The protocol defines:

- Undefined
- Player
- Explosion
- VendingMachine
- CH47
- CargoShip
- Crate
- GenericRadius
- PatrolHelicopter

Each marker can contain:

- `id`
- `type`
- `x`, `y`
- optional `steamId`
- optional `rotation`
- optional `radius`
- optional colors/alpha
- optional `name`
- optional `outOfStock`
- `sellOrders[]`

## 11. Vending-machine schema

The protobuf still defines a `VendingMachine` marker and `SellOrder`.

Each sell order contains:

| Field | Type | Meaning |
|---|---|---|
| `itemId` | int32 | Item being sold |
| `quantity` | int32 | Quantity per purchase |
| `currencyId` | int32 | Currency item ID |
| `costPerItem` | int32 | Price |
| `amountInStock` | int32 | Available stock |
| `itemIsBlueprint` | bool | Item is a blueprint |
| `currencyIsBlueprint` | bool | Currency is a blueprint |
| `itemCondition` | float? | Current condition |
| `itemConditionMax` | float? | Maximum condition |

**Important:** The schema does not prove current availability. A current server/service may return no vending markers even though the protobuf still defines them. The explorer should still call `getMapMarkers`, save the raw response, count marker types, and report exactly what the live connection returned.

## 12. Clan information

`getClanInfo` can expose:

- Clan ID
- Name
- Creation time
- Creator
- MOTD
- MOTD timestamp/author
- Logo
- Color
- Roles
- Members
- Invitations
- Maximum member count

Roles include permission-like fields for MOTD/logo/invites/kicks/promotions/demotions/player notes/log access.

Members include:

- SteamID
- Role ID
- Joined time
- Last seen
- Notes
- Online state

Availability depends on the player's clan/context and current implementation.

## 13. Clan chat

`getClanChat` returns:

- SteamID
- Name
- Message
- Timestamp

`sendClanMessage` sends a clan message.

Live broadcasts include:

- `clanChanged`
- `clanMessage`

## 14. Security cameras

Current protocol requests:

- `cameraSubscribe`
- `cameraUnsubscribe`
- `cameraInput`

`cameraSubscribe` takes a camera ID and returns:

- width
- height
- near plane
- far plane
- control flags

Camera broadcasts use `cameraRays` and can contain:

- vertical FOV
- sample offset
- ray data bytes
- distance
- detected entities

Defined camera entity types include:

- Tree
- Player

Each detected entity can include:

- entity ID
- type
- position
- rotation
- size
- optional name

Camera support should be a separate module because its data format differs from normal request/response data.

## 15. Nexus authentication

`getNexusAuth` takes an `appKey` and can return:

- `serverId`
- `playerToken`

This is Nexus-related authentication, not a general server-information endpoint.

## 16. Error handling

Responses can contain `success` or `error`.

`AppError` contains:

```
error: string
```

The explorer should record:

- timestamp
- server identity
- request name
- sequence number
- duration
- success/failure
- error text
- decoded response
- raw response when possible

## 17. Live broadcast inventory

Current protobuf broadcasts:

| Broadcast | Data |
|---|---|
| `teamChanged` | Updated team information |
| `teamMessage` | New team-chat message |
| `entityChanged` | Smart entity state change |
| `clanChanged` | Updated clan information |
| `clanMessage` | New clan message |
| `cameraRays` | Camera data |

## 18. Recommended Rust API Explorer

### Phase 1 — read-only discovery

Implement:

- Connection/authentication
- `getInfo`
- `getTime`
- `getMap`
- `getTeamInfo`
- `getTeamChat`
- `getEntityInfo`
- `getMapMarkers`
- `getClanInfo`
- `getClanChat`

Save every raw decoded response.

### Phase 2 — live data

Implement:

- Team changes
- Team messages
- Entity changes
- Clan changes
- Clan messages
- Camera broadcasts

### Phase 3 — actions

After read-only testing:

- Send team message
- Send clan message
- Set compatible entity values
- Camera input
- Other supported actions

## 19. Capability classification

Every API result should be classified:

**A — Directly available:** current connection returned useful data.

**B — Prerequisite required:** API exists but needs a paired/registered entity, team, clan, camera, subscription, etc.

**C — Protocol-defined/server-dependent:** protobuf contains the field/request but the current server/service may not populate it.

**D — Not available through Rust+:** data requires another source such as RCON, a server plugin, or an external service.

This distinction is especially important for vending machines.

## 20. Raw transaction format

A useful internal representation:

```json
{
  "timestamp": "2026-09-27T22:00:00Z",
  "server": {
    "name": "Example Server"
  },
  "request": {
    "name": "getMapMarkers",
    "sequence": 42
  },
  "response": {
    "success": true,
    "mapMarkers": {
      "markers": []
    }
  },
  "durationMs": 183
}
```

A database can be used instead of JSON files, but the raw decoded payload should remain available for debugging.

## 21. Proposed explorer tabs

```
SERVER
TIME
MAP
MARKERS
TEAM
TEAM CHAT
ENTITIES
STORAGE
CLAN
CLAN CHAT
CAMERAS
EVENT STREAM
RAW API
ERROR LOG
```

The MARKERS tab should show marker-type counts and explicitly report when vending markers are absent.

## 22. Sources

- Facepunch Rust Companion Server documentation:
  https://wiki.facepunch.com/rust/rust-companion-server
- Community Rust+ protobuf:
  https://github.com/liamcottle/rustplus.js/blob/master/rustplus.proto
- Community Rust+ Node.js implementation:
  https://github.com/liamcottle/rustplus.js
- Rust+ implementation examples:
  https://github.com/liamcottle/rustplus.js/blob/master/README.md

## Bottom line

Rust+ exposes substantial player-accessible data, but the protocol schema and actual live data are different things. The explorer should implement the request set, capture raw responses, listen for broadcasts, and maintain a live capability report for the connected server. This lets us discover what a current server actually exposes instead of assuming an older library's behavior is still valid.
