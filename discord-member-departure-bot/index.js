require("dotenv").config();

const {
  Client, GatewayIntentBits, EmbedBuilder, AuditLogEvent
} = require("discord.js");
const Database = require("better-sqlite3");
const fs = require("node:fs");
const path = require("node:path");

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const CHANNEL_ID = process.env.DEPARTURE_CHANNEL_ID;
const DATABASE_PATH = process.env.DATABASE_PATH || "./data/departures.sqlite";
const STEAM_LOOKUP_URL = (process.env.STEAM_LINK_LOOKUP_URL || "").replace(/\/$/, "");
const STEAM_LOOKUP_TOKEN = process.env.STEAM_LINK_LOOKUP_TOKEN || "";

if (!TOKEN || !GUILD_ID || !CHANNEL_ID) {
  throw new Error("DISCORD_TOKEN, DISCORD_GUILD_ID, and DEPARTURE_CHANNEL_ID are required.");
}

fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
const db = new Database(DATABASE_PATH);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

db.exec(`
CREATE TABLE IF NOT EXISTS member_snapshots (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  account_created_at INTEGER,
  joined_at INTEGER,
  roles_json TEXT NOT NULL DEFAULT '[]',
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
CREATE TABLE IF NOT EXISTS departures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  account_created_at INTEGER,
  joined_at INTEGER,
  departed_at INTEGER NOT NULL,
  departure_type TEXT NOT NULL CHECK (departure_type IN ('left','kicked','banned')),
  moderator_id TEXT,
  moderator_tag TEXT,
  reason TEXT,
  steam_id TEXT,
  roles_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE(guild_id, user_id, departed_at)
);
CREATE INDEX IF NOT EXISTS idx_departures_user ON departures(guild_id,user_id,departed_at DESC);
CREATE INDEX IF NOT EXISTS idx_departures_time ON departures(guild_id,departed_at DESC);
`);

const insertSnapshot = db.prepare(`
INSERT INTO member_snapshots
(guild_id,user_id,username,display_name,avatar_url,account_created_at,joined_at,roles_json,last_seen_at)
VALUES (@guildId,@userId,@username,@displayName,@avatarUrl,@accountCreatedAt,@joinedAt,@rolesJson,@now)
ON CONFLICT(guild_id,user_id) DO UPDATE SET
 username=excluded.username, display_name=excluded.display_name,
 avatar_url=excluded.avatar_url, account_created_at=excluded.account_created_at,
 joined_at=COALESCE(excluded.joined_at,member_snapshots.joined_at),
 roles_json=excluded.roles_json,last_seen_at=excluded.last_seen_at
`);
const getSnapshot = db.prepare("SELECT * FROM member_snapshots WHERE guild_id=? AND user_id=?");
const deleteSnapshot = db.prepare("DELETE FROM member_snapshots WHERE guild_id=? AND user_id=?");
const insertDeparture = db.prepare(`
INSERT OR IGNORE INTO departures
(guild_id,user_id,username,display_name,avatar_url,account_created_at,joined_at,departed_at,
 departure_type,moderator_id,moderator_tag,reason,steam_id,roles_json)
VALUES (@guildId,@userId,@username,@displayName,@avatarUrl,@accountCreatedAt,@joinedAt,@departedAt,
 @departureType,@moderatorId,@moderatorTag,@reason,@steamId,@rolesJson)
`);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

const pendingLeaves = new Map();
const processedDepartures = new Set();
const recentBans = new Map();

function snapshotMember(member) {
  if (!member || member.user?.bot) return;
  const user = member.user;
  insertSnapshot.run({
    guildId: member.guild.id,
    userId: user.id,
    username: user.username,
    displayName: member.displayName || user.globalName || user.username,
    avatarUrl: user.displayAvatarURL({ extension: "png", size: 256 }),
    accountCreatedAt: user.createdTimestamp || null,
    joinedAt: member.joinedTimestamp || null,
    rolesJson: JSON.stringify(member.roles.cache.filter(r => r.id !== member.guild.id).map(r => ({ id: r.id, name: r.name }))),
    now: Date.now()
  });
}

function fallbackSnapshot(user, guildId) {
  return {
    guild_id: guildId,
    user_id: user.id,
    username: user.username || "Unknown username",
    display_name: user.globalName || user.username || "Unknown member",
    avatar_url: user.displayAvatarURL?.({ extension: "png", size: 256 }) || null,
    account_created_at: user.createdTimestamp || null,
    joined_at: null,
    roles_json: "[]"
  };
}

async function lookupSteamId(discordId) {
  if (!STEAM_LOOKUP_URL || !STEAM_LOOKUP_TOKEN) return "unavailable";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${STEAM_LOOKUP_URL}/${encodeURIComponent(discordId)}`, {
      headers: { Authorization: `Bearer ${STEAM_LOOKUP_TOKEN}` },
      signal: controller.signal
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Steam-link lookup returned HTTP ${response.status}`);
    const data = await response.json();
    const steamId = String(data.steamId || data.steam_id || "");
    return /^[0-9]{17}$/.test(steamId) ? steamId : null;
  } catch (error) {
    console.error(`SteamID lookup failed for Discord user ${discordId}:`, error.message);
    return "unavailable";
  } finally {
    clearTimeout(timeout);
  }
}

function timestamp(ts) {
  return ts ? `<t:${Math.floor(ts / 1000)}:f>` : "Unknown";
}

function duration(joinedAt, departedAt) {
  if (!joinedAt) return "Unknown";
  const ms = Math.max(0, departedAt - joinedAt);
  const days = Math.floor(ms / 86400000);
  const years = Math.floor(days / 365);
  const months = Math.floor((days % 365) / 30);
  const remainingDays = days - years * 365 - months * 30;
  const parts = [];
  if (years) parts.push(`${years}y`);
  if (months) parts.push(`${months}mo`);
  if (remainingDays || !parts.length) parts.push(`${remainingDays}d`);
  return parts.join(" ");
}

function makeEmbed(record) {
  const config = {
    left: { title: "MEMBER LEFT SERVER", color: 0x64748b, label: "Voluntarily left" },
    kicked: { title: "MEMBER KICKED", color: 0xd97706, label: "Kicked" },
    banned: { title: "MEMBER BANNED", color: 0xdc2626, label: "Banned" }
  }[record.departureType];

  const embed = new EmbedBuilder()
    .setColor(config.color)
    .setTitle(config.title)
    .setDescription(`**${record.displayName}**\n@${record.username}`)
    .addFields(
      { name: "Discord User ID", value: `\`${record.userId}\``, inline: true },
      { name: "Departure", value: config.label, inline: true },
      { name: "Account created", value: timestamp(record.accountCreatedAt), inline: true },
      { name: "Joined server", value: timestamp(record.joinedAt), inline: true },
      { name: "Time in server", value: duration(record.joinedAt, record.departedAt), inline: true },
      { name: "Departed", value: timestamp(record.departedAt), inline: true }
    );

  if (/^[0-9]{17}$/.test(String(record.steamId || ""))) {
    embed.addFields({
      name: "Steam Profile",
      value: `[${record.steamId}](https://steamcommunity.com/profiles/${record.steamId})`,
      inline: false
    });
  } else if (record.steamId === "unavailable") {
    embed.addFields({ name: "Steam Information", value: "Steam link lookup unavailable", inline: false });
  } else {
    embed.addFields({ name: "Steam Information", value: "No Steam account linked", inline: false });
  }

  if (record.departureType !== "left") {
    embed.addFields({
      name: record.departureType === "banned" ? "Banned by" : "Kicked by",
      value: record.moderatorId ? `<@${record.moderatorId}> (${record.moderatorTag || "Unknown moderator"})` : "Moderator could not be identified",
      inline: true
    });
    embed.addFields({ name: "Reason", value: record.reason || "No reason provided", inline: true });
  }

  let roles = [];
  try { roles = JSON.parse(record.rolesJson || "[]"); } catch {}
  embed.addFields({
    name: "Roles held",
    value: roles.length ? roles.map(r => r.name).join(", ").slice(0, 1024) : "No roles recorded",
    inline: false
  });
  if (record.avatarUrl) embed.setThumbnail(record.avatarUrl);
  embed.setFooter({ text: `Departure record • User ${record.userId}` }).setTimestamp(record.departedAt);
  return embed;
}

async function findAuditEntry(guild, action, userId, maxAttempts = 5) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const logs = await guild.fetchAuditLogs({ type: action, limit: 10 });
      const now = Date.now();
      const entry = logs.entries.find(item =>
        item.target?.id === userId &&
        now - item.createdTimestamp < 30_000
      );
      if (entry) return entry;
    } catch (error) {
      console.warn(`Audit log lookup attempt ${attempt} failed:`, error.message);
    }
    if (attempt < maxAttempts) await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
  }
  return null;
}

async function finalizeDeparture(guild, user, type, auditEntry = null) {
  const key = `${guild.id}:${user.id}`;
  if (processedDepartures.has(key)) return;
  processedDepartures.add(key);

  const saved = getSnapshot.get(guild.id, user.id) || fallbackSnapshot(user, guild.id);
  const departedAt = Date.now();
  const steamId = await lookupSteamId(user.id);
  const record = {
    guildId: guild.id,
    userId: user.id,
    username: saved.username || user.username || "Unknown",
    displayName: saved.display_name || user.globalName || user.username || "Unknown",
    avatarUrl: saved.avatar_url,
    accountCreatedAt: saved.account_created_at,
    joinedAt: saved.joined_at,
    departedAt,
    departureType: type,
    moderatorId: auditEntry?.executor?.id || null,
    moderatorTag: auditEntry?.executor?.tag || auditEntry?.executor?.username || null,
    reason: auditEntry?.reason || null,
    steamId,
    rolesJson: saved.roles_json || "[]"
  };

  insertDeparture.run(record);
  deleteSnapshot.run(guild.id, user.id);

  const channel = await guild.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel?.isTextBased()) {
    console.error(`Departure channel ${CHANNEL_ID} is unavailable or not text-based.`);
    return;
  }
  await channel.send({ embeds: [makeEmbed(record)] });
  console.log(`Recorded ${type} departure for ${record.username} (${record.userId}).`);
}

async function processKick(guild, user) {
  const entry = await findAuditEntry(guild, AuditLogEvent.MemberKick, user.id);
  await finalizeDeparture(guild, user, "kicked", entry);
}

async function processBan(guild, user) {
  const entry = await findAuditEntry(guild, AuditLogEvent.MemberBanAdd, user.id);
  await finalizeDeparture(guild, user, "banned", entry);
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const guild = await client.guilds.fetch(GUILD_ID);
  await guild.members.fetch();
  for (const member of guild.members.cache.values()) snapshotMember(member);
  console.log(`Departure tracking ready for ${guild.name}; cached ${guild.members.cache.size} members.`);
});

client.on("guildMemberAdd", member => {
  if (member.guild.id !== GUILD_ID) return;
  const key = `${member.guild.id}:${member.id}`;
  processedDepartures.delete(key);
  recentBans.delete(member.id);
  snapshotMember(member);
});

client.on("guildMemberUpdate", (_oldMember, newMember) => {
  if (newMember.guild.id === GUILD_ID) snapshotMember(newMember);
});

client.on("guildBanAdd", ban => {
  if (ban.guild.id !== GUILD_ID) return;
  recentBans.set(ban.user.id, Date.now());
  processBan(ban.guild, ban.user).catch(error => console.error("Ban processing failed:", error));
});

client.on("guildMemberRemove", member => {
  if (member.guild.id !== GUILD_ID || member.user.bot) return;
  const user = member.user;
  const key = `${member.guild.id}:${user.id}`;
  if (pendingLeaves.has(key)) clearTimeout(pendingLeaves.get(key));
  const timer = setTimeout(async () => {
    pendingLeaves.delete(key);
    if (processedDepartures.has(key)) return;
    if (recentBans.has(user.id) && Date.now() - recentBans.get(user.id) < 60_000) return;
    const kickEntry = await findAuditEntry(member.guild, AuditLogEvent.MemberKick, user.id, 3);
    if (kickEntry) await finalizeDeparture(member.guild, user, "kicked", kickEntry);
    else await finalizeDeparture(member.guild, user, "left");
  }, 2500);
  pendingLeaves.set(key, timer);
});

client.on("error", error => console.error("Discord client error:", error));
client.on("shardError", error => console.error("Discord shard error:", error));

async function shutdown() {
  try { db.close(); } catch {}
  client.destroy();
  process.exit(0);
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

client.login(TOKEN);
