require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
} = require("discord.js");
const Database = require("better-sqlite3");
const fs = require("fs");
const pathLib = require("path");

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const DATABASE_PATH = process.env.DATABASE_PATH || "./data/activity.sqlite";

if (!TOKEN) throw new Error("Missing DISCORD_TOKEN");
if (!GUILD_ID) throw new Error("Missing DISCORD_GUILD_ID");

fs.mkdirSync(pathLib.dirname(DATABASE_PATH), { recursive: true });

const db = new Database(DATABASE_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS member_activity (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  username TEXT,
  display_name TEXT,
  first_seen_at INTEGER,
  last_activity_at INTEGER,
  last_activity_type TEXT,
  last_channel_id TEXT,
  last_channel_name TEXT,
  last_message_at INTEGER,
  last_message_channel_id TEXT,
  last_message_channel_name TEXT,
  last_voice_at INTEGER,
  last_voice_event TEXT,
  last_voice_channel_id TEXT,
  last_voice_channel_name TEXT,
  last_command_at INTEGER,
  last_command_name TEXT,
  last_join_at INTEGER,
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_activity_last
ON member_activity(guild_id, last_activity_at);
`);

const upsert = db.prepare(`
INSERT INTO member_activity
(guild_id,user_id,username,display_name,first_seen_at,last_activity_at,
 last_activity_type,last_channel_id,last_channel_name)
VALUES (@guildId,@userId,@username,@displayName,@now,@now,@type,@channelId,@channelName)
ON CONFLICT(guild_id,user_id) DO UPDATE SET
 username=excluded.username,
 display_name=excluded.display_name,
 last_activity_at=excluded.last_activity_at,
 last_activity_type=excluded.last_activity_type,
 last_channel_id=excluded.last_channel_id,
 last_channel_name=excluded.last_channel_name
`);

const updateMessage = db.prepare(`
UPDATE member_activity SET
 username=@username, display_name=@displayName,
 last_activity_at=@now, last_activity_type='message',
 last_channel_id=@channelId, last_channel_name=@channelName,
 last_message_at=@now, last_message_channel_id=@channelId,
 last_message_channel_name=@channelName
WHERE guild_id=@guildId AND user_id=@userId
`);

const updateVoice = db.prepare(`
UPDATE member_activity SET
 username=@username, display_name=@displayName,
 last_activity_at=@now, last_activity_type='voice',
 last_channel_id=@channelId, last_channel_name=@channelName,
 last_voice_at=@now, last_voice_event=@event,
 last_voice_channel_id=@channelId, last_voice_channel_name=@channelName
WHERE guild_id=@guildId AND user_id=@userId
`);

const updateCommand = db.prepare(`
UPDATE member_activity SET
 username=@username, display_name=@displayName,
 last_activity_at=@now, last_activity_type='command',
 last_channel_id=@channelId, last_channel_name=@channelName,
 last_command_at=@now, last_command_name=@commandName
WHERE guild_id=@guildId AND user_id=@userId
`);

const updateJoin = db.prepare(`
UPDATE member_activity SET
 username=@username, display_name=@displayName,
 last_activity_at=@now, last_activity_type='server_join',
 last_join_at=@now
WHERE guild_id=@guildId AND user_id=@userId
`);

const getMember = db.prepare(
  "SELECT * FROM member_activity WHERE guild_id=? AND user_id=?"
);
const getRecent = db.prepare(`
SELECT * FROM member_activity
WHERE guild_id=?
ORDER BY last_activity_at DESC
LIMIT ?
`);
const getInactive = db.prepare(`
SELECT * FROM member_activity
WHERE guild_id=? AND last_activity_at IS NOT NULL AND last_activity_at < ?
ORDER BY last_activity_at ASC
LIMIT ?
`);

function now() { return Date.now(); }

function ensureMember(member) {
  if (!member || member.user.bot) return;
  const existing = getMember.get(member.guild.id, member.id);
  if (existing) {
    db.prepare("UPDATE member_activity SET username=?,display_name=? WHERE guild_id=? AND user_id=?")
      .run(member.user.username, member.displayName || member.user.username,
           member.guild.id, member.id);
    return;
  }
  const t = now();
  upsert.run({
    guildId: member.guild.id,
    userId: member.id,
    username: member.user.username,
    displayName: member.displayName || member.user.username,
    now: t,
    type: "first_seen",
    channelId: null,
    channelName: null
  });
}

function formatWhen(ts) {
  return ts ? `<t:${Math.floor(ts / 1000)}:R> (<t:${Math.floor(ts / 1000)}:f>)` : "Never";
}

function activityText(row) {
  if (!row || !row.last_activity_at) return "No recorded activity";
  if (row.last_activity_type === "message")
    return `💬 Message in <#${row.last_channel_id}>`;
  if (row.last_activity_type === "voice")
    return `🔊 Voice ${row.last_voice_event || "activity"}${row.last_channel_id ? ` in <#${row.last_channel_id}>` : ""}`;
  if (row.last_activity_type === "command")
    return `⚡ /${row.last_command_name || "command"}`;
  if (row.last_activity_type === "server_join") return "👋 Joined the server";
  return "Server activity";
}

function makeEmbed(member, row) {
  return new EmbedBuilder()
    .setTitle(`Server Activity — ${member.displayName}`)
    .setThumbnail(member.displayAvatarURL({ size: 128 }))
    .addFields(
      { name: "Last server activity", value: `${formatWhen(row?.last_activity_at)}\\n${activityText(row)}` },
      { name: "Last message", value: row?.last_message_at ? `${formatWhen(row.last_message_at)}\\n<#${row.last_message_channel_id}>` : "Never", inline: true },
      { name: "Last voice", value: row?.last_voice_at ? `${formatWhen(row.last_voice_at)}\\n${row.last_voice_event || "Activity"}${row.last_voice_channel_id ? ` — <#${row.last_voice_channel_id}>` : ""}` : "Never", inline: true },
      { name: "Last command", value: row?.last_command_at ? `${formatWhen(row.last_command_at)}\\n/${row.last_command_name}` : "Never", inline: true },
      { name: "Last server join", value: row?.last_join_at ? formatWhen(row.last_join_at) : "Not recorded", inline: true }
    )
    .setTimestamp();
}

const commands = [
  new SlashCommandBuilder()
    .setName("activity")
    .setDescription("Show a member's activity in this server.")
    .addUserOption(o => o.setName("user").setDescription("Member to check").setRequired(false)),
  new SlashCommandBuilder()
    .setName("recent")
    .setDescription("Show the members with the most recent server activity.")
    .addIntegerOption(o => o.setName("limit").setDescription("1-25").setMinValue(1).setMaxValue(25).setRequired(false)),
  new SlashCommandBuilder()
    .setName("inactive")
    .setDescription("Show members inactive for at least the selected number of days.")
    .addIntegerOption(o => o.setName("days").setDescription("Days inactive").setMinValue(1).setMaxValue(3650).setRequired(false))
    .addIntegerOption(o => o.setName("limit").setDescription("1-50").setMinValue(1).setMaxValue(50).setRequired(false))
].map(c => c.toJSON());

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(client.user.id, GUILD_ID),
    { body: commands }
  );

  const guild = client.guilds.cache.get(GUILD_ID);
  if (guild) {
    await guild.members.fetch();
    for (const member of guild.members.cache.values()) ensureMember(member);
  }

  console.log(`Server activity tracking ready for ${GUILD_ID}`);
});

client.on("messageCreate", message => {
  if (!message.guild || message.guild.id !== GUILD_ID || message.author.bot || !message.member) return;
  ensureMember(message.member);
  updateMessage.run({
    guildId: GUILD_ID,
    userId: message.author.id,
    username: message.author.username,
    displayName: message.member.displayName || message.author.username,
    now: message.createdTimestamp || now(),
    channelId: message.channelId,
    channelName: message.channel?.name || "unknown"
  });
});

client.on("voiceStateUpdate", (oldState, newState) => {
  if (newState.guild.id !== GUILD_ID) return;
  const member = newState.member || oldState.member;
  if (!member || member.user.bot) return;
  ensureMember(member);

  let event, channelId = null, channelName = null;
  if (!oldState.channelId && newState.channelId) {
    event = "joined"; channelId = newState.channelId; channelName = newState.channel?.name;
  } else if (oldState.channelId && !newState.channelId) {
    event = "left"; channelId = oldState.channelId; channelName = oldState.channel?.name;
  } else if (oldState.channelId !== newState.channelId) {
    event = "switched"; channelId = newState.channelId; channelName = newState.channel?.name;
  } else return;

  updateVoice.run({
    guildId: GUILD_ID, userId: member.id,
    username: member.user.username,
    displayName: member.displayName || member.user.username,
    now: now(), channelId, channelName, event
  });
});

client.on("guildMemberAdd", member => {
  if (member.guild.id !== GUILD_ID || member.user.bot) return;
  ensureMember(member);
  updateJoin.run({
    guildId: GUILD_ID, userId: member.id,
    username: member.user.username,
    displayName: member.displayName || member.user.username,
    now: now()
  });
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand() || interaction.guildId !== GUILD_ID) return;

  const target = interaction.commandName === "activity"
    ? (interaction.options.getMember("user") || interaction.member)
    : interaction.member;

  if (target && !target.user.bot) ensureMember(target);

  if (interaction.commandName === "activity") {
    const row = getMember.get(GUILD_ID, target.id);
    await interaction.reply({ embeds: [makeEmbed(target, row)] });
    updateCommand.run({
      guildId: GUILD_ID, userId: interaction.user.id,
      username: interaction.user.username,
      displayName: interaction.member.displayName || interaction.user.username,
      now: now(), channelId: interaction.channelId,
      channelName: interaction.channel?.name || "unknown",
      commandName: "activity"
    });
    return;
  }

  if (interaction.commandName === "recent") {
    const limit = interaction.options.getInteger("limit") || 10;
    const rows = getRecent.all(GUILD_ID, limit);
    const description = rows.length
      ? rows.map((r,i) => `**${i+1}. ${r.display_name || r.username}** — ${formatWhen(r.last_activity_at)}\\n${activityText(r)}`).join("\\n\\n")
      : "No activity recorded yet.";

    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle("Recent Server Activity").setDescription(description).setTimestamp()]
    });
    recordCommand(interaction, "recent");
    return;
  }

  if (interaction.commandName === "inactive") {
    const days = interaction.options.getInteger("days") || 30;
    const limit = interaction.options.getInteger("limit") || 25;
    const cutoff = now() - days * 86400000;
    const rows = getInactive.all(GUILD_ID, cutoff, limit);
    const description = rows.length
      ? rows.map((r,i) => `**${i+1}. ${r.display_name || r.username}** — ${formatWhen(r.last_activity_at)}\\n${activityText(r)}`).join("\\n\\n")
      : `No members have been inactive for ${days}+ days.`;

    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle(`Inactive Members — ${days}+ Days`).setDescription(description).setTimestamp()]
    });
    recordCommand(interaction, "inactive");
  }
});

function recordCommand(interaction, commandName) {
  updateCommand.run({
    guildId: GUILD_ID, userId: interaction.user.id,
    username: interaction.user.username,
    displayName: interaction.member.displayName || interaction.user.username,
    now: now(), channelId: interaction.channelId,
    channelName: interaction.channel?.name || "unknown",
    commandName
  });
}

function shutdown() {
  try { db.close(); } catch {}
  client.destroy();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

client.login(TOKEN);
