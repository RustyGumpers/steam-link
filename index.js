const {
    Client,
    GatewayIntentBits,
    PermissionFlagsBits,
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    MessageFlags
} = require('discord.js');

const Database = require('better-sqlite3');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const envOr = (name, fallback) => {
    const value = process.env[name];
    return value === undefined || value === '' ? fallback : value;
};

let config = {
    guildId: envOr('DISCORD_GUILD_ID', undefined),
    roles: {
        recruit: envOr('RECRUIT_ROLE_ID', undefined),
        gump: envOr('GUMP_ROLE_ID', undefined),
        consigliere: envOr('CONSIGLIERE_ROLE_ID', undefined)
    },
    settings: {
        listPageSize: envOr('LIST_PAGE_SIZE', 10),
        auditPageSize: envOr('AUDIT_PAGE_SIZE', 10),
        maxAuditEntries: envOr('MAX_AUDIT_ENTRIES', 250),
        linkPromptTimezone: envOr('LINK_PROMPT_TIMEZONE', process.env.TZ || 'UTC'),
        backupRetention: envOr('BACKUP_RETENTION', 7)
    }
};


if (!process.env.DISCORD_TOKEN) {
    console.error('ERROR: DISCORD_TOKEN is missing from Railway Variables.');
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildPresences
    ]
});

// ============================================================
// DATABASE
// ============================================================

const databasePath = process.env.DATABASE_PATH || '/data/database.sqlite';
const db = new Database(databasePath);
console.log(`SQLite database: ${databasePath}`);

db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
    CREATE TABLE IF NOT EXISTS steam_links (
        discord_id TEXT PRIMARY KEY,
        steam_id TEXT NOT NULL UNIQUE,
        discord_username TEXT,
        linked_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        old_steam_id TEXT,
        new_steam_id TEXT,
        details TEXT,
        timestamp INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS nickname_cleanup (
        steam_id TEXT PRIMARY KEY,
        discord_username TEXT NOT NULL,
        queued_at INTEGER NOT NULL,
        reason TEXT
    );

    CREATE TABLE IF NOT EXISTS sync_tokens (
        discord_id TEXT PRIMARY KEY,
        steam_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS link_prompt_notifications (
        discord_id TEXT PRIMARY KEY,
        notified_at INTEGER NOT NULL
    );
`);

// ------------------------------------------------------------
// Migrations
// ------------------------------------------------------------

const steamColumns = db
    .prepare('PRAGMA table_info(steam_links)')
    .all()
    .map(row => row.name);

if (!steamColumns.includes('discord_username')) {
    db.exec(`
        ALTER TABLE steam_links
        ADD COLUMN discord_username TEXT
    `);
}

// ============================================================
// HELPERS
// ============================================================

const ROLE_RECRUIT = config.roles.recruit;
const ROLE_GUMP = config.roles.gump;
const ROLE_CONSIGLIERE = config.roles.consigliere;

function positiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1) return fallback;
    return Math.min(number, max);
}

const PAGE_SIZE = positiveInteger(config.settings?.listPageSize, 10, 10);
const AUDIT_PAGE_SIZE = positiveInteger(config.settings?.auditPageSize, 10, 50);
const MAX_AUDIT_ENTRIES = positiveInteger(config.settings?.maxAuditEntries, 250, 5000);
const BACKUP_RETENTION = positiveInteger(config.settings?.backupRetention, 7, 100);
const DISCORD_SAFE_CONTENT_LIMIT = 1900;

const requiredConfig = [
    ['DISCORD_GUILD_ID', config.guildId],
    ['RECRUIT_ROLE_ID', ROLE_RECRUIT],
    ['GUMP_ROLE_ID', ROLE_GUMP],
    ['CONSIGLIERE_ROLE_ID', ROLE_CONSIGLIERE]
];

const missingConfig = requiredConfig.filter(([, value]) => !value);
if (missingConfig.length) {
    console.error(`ERROR: Missing Railway configuration: ${missingConfig.map(([name]) => name).join(', ')}`);
    process.exit(1);
}

function isValidSteamId(steamId) {
    return /^[0-9]{17}$/.test(String(steamId));
}

function isPrivileged(member) {
    return Boolean(
        member.permissions.has(PermissionFlagsBits.Administrator) ||
        member.roles.cache.has(ROLE_CONSIGLIERE)
    );
}

function canSelfLink(member) {
    return Boolean(
        member.roles.cache.has(ROLE_RECRUIT) ||
        member.roles.cache.has(ROLE_GUMP)
    );
}

function hasRosterRole(member) {
    return Boolean(
        member.roles.cache.has(ROLE_RECRUIT) ||
        member.roles.cache.has(ROLE_GUMP)
    );
}

function getRosterRole(member) {
    if (member.roles.cache.has(ROLE_GUMP)) {
        return 'Gump';
    }

    if (member.roles.cache.has(ROLE_RECRUIT)) {
        return 'Recruit';
    }

    return null;
}

function getDesiredNickname(member) {
    const username = member.user.username;

    if (member.roles.cache.has(ROLE_GUMP)) {
        return `Gump ${username}`.slice(0, 32);
    }

    if (member.roles.cache.has(ROLE_RECRUIT)) {
        return `Recruit ${username}`.slice(0, 32);
    }

    return username.slice(0, 32);
}

function getBaseNickname(username) {
    return String(username || '').slice(0, 32);
}

function getMemberUsername(member) {
    return member.user.username;
}

function getLink(discordId) {
    return db.prepare(`
        SELECT discord_id, steam_id, discord_username, linked_at
        FROM steam_links
        WHERE discord_id = ?
    `).get(discordId);
}

function getLinkBySteamId(steamId) {
    return db.prepare(`
        SELECT discord_id, steam_id, discord_username, linked_at
        FROM steam_links
        WHERE steam_id = ?
    `).get(steamId);
}

function addAudit({
    action,
    actorId,
    targetId,
    oldSteamId = null,
    newSteamId = null,
    details = null
}) {
    db.prepare(`
        INSERT INTO audit_log (
            action,
            actor_id,
            target_id,
            old_steam_id,
            new_steam_id,
            details,
            timestamp
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
        action,
        actorId,
        targetId,
        oldSteamId,
        newSteamId,
        details,
        Date.now()
    );
}

function queueNicknameCleanup(steamId, discordUsername, reason) {
    if (!isValidSteamId(steamId)) {
        return;
    }

    db.prepare(`
        INSERT INTO nickname_cleanup (
            steam_id,
            discord_username,
            queued_at,
            reason
        )
        VALUES (?, ?, ?, ?)
        ON CONFLICT(steam_id)
        DO UPDATE SET
            discord_username = excluded.discord_username,
            queued_at = excluded.queued_at,
            reason = excluded.reason
    `).run(
        steamId,
        getBaseNickname(discordUsername),
        Date.now(),
        reason || null
    );
}

function getPage(items, page, pageSize) {
    const itemArray = Array.isArray(items)
        ? items
        : Array.from(items.values());

    const totalPages = Math.max(
        1,
        Math.ceil(itemArray.length / pageSize)
    );

    const safePage = Math.max(
        0,
        Math.min(
            Number.isInteger(page) ? page : 0,
            totalPages - 1
        )
    );

    const start = safePage * pageSize;

    return {
        items: itemArray.slice(start, start + pageSize),
        page: safePage,
        totalPages
    };
}

function truncateDiscordContent(content, limit = DISCORD_SAFE_CONTENT_LIMIT) {
    const text = String(content || '');
    return text.length <= limit ? text : text.slice(0, Math.max(0, limit - 1)) + '…';
}

function paginationRow(prefix, page, totalPages) {
    const row = new ActionRowBuilder();

    if (page > 0) {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`${prefix}:page:${page - 1}`)
                .setLabel('Previous')
                .setStyle(ButtonStyle.Secondary)
        );
    }

    if (page < totalPages - 1) {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`${prefix}:page:${page + 1}`)
                .setLabel('Next')
                .setStyle(ButtonStyle.Secondary)
        );
    }

    return row.components.length ? row : null;
}

async function getGuild() {
    const guild = client.guilds.cache.get(config.guildId);

    if (!guild) {
        throw new Error(
            `Guild ${config.guildId} was not found in the bot's cached guilds.`
        );
    }

    return guild;
}

// Discord Gateway member-list requests (opcode 8) are rate limited.
// Use the cached collection for instant roster display, coalesce concurrent
// full-member requests, and keep a short successful-fetch cooldown so the
// relay timer and commands do not repeatedly request the entire guild.
const MEMBER_FETCH_COOLDOWN_MS = 60 * 1000;
let lastSuccessfulMemberFetch = 0;
let memberFetchPromise = null;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getGatewayRetryAfterMs(error) {
    const retryAfter = Number(error?.data?.retry_after);

    if (Number.isFinite(retryAfter) && retryAfter > 0) {
        return Math.ceil(retryAfter * 1000);
    }

    return 0;
}

async function fetchGuildMembers(options = {}) {
    const guild = await getGuild();
    const force = options.force !== false;
    const cacheComplete = guild.members.cache.size >= guild.memberCount;

    if (!force) {
        return {
            guild,
            members: guild.members.cache,
            complete: cacheComplete,
            fetched: false
        };
    }

    // Do not send another Gateway member-list request when a complete
    // snapshot was fetched recently. The Discord client cache is already
    // updated by normal member events, so callers still see current data
    // without repeatedly requesting the entire guild.
    if (
        cacheComplete &&
        !options.bypassCooldown &&
        lastSuccessfulMemberFetch > 0 &&
        Date.now() - lastSuccessfulMemberFetch < MEMBER_FETCH_COOLDOWN_MS
    ) {
        return {
            guild,
            members: guild.members.cache,
            complete: true,
            fetched: false
        };
    }

    // Coalesce simultaneous callers. Startup relay publishing, the 60-second
    // relay timer, /list, /stats, /prune, and roster refreshes can otherwise
    // all issue their own Gateway member-list request at the same time.
    if (memberFetchPromise) {
        return memberFetchPromise;
    }

    memberFetchPromise = (async () => {
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const members = await guild.members.fetch();
                const complete = members.size >= guild.memberCount;

                if (!complete) {
                    throw new Error(
                        `Discord member snapshot incomplete (${members.size}/${guild.memberCount}).`
                    );
                }

                lastSuccessfulMemberFetch = Date.now();

                return {
                    guild,
                    members,
                    complete: true,
                    fetched: true
                };
            } catch (error) {
                const retryAfterMs = getGatewayRetryAfterMs(error);

                if (attempt === 3) {
                    throw error;
                }

                await sleep(
                    retryAfterMs > 0
                        ? retryAfterMs + 500
                        : 1500 * attempt
                );
            }
        }

        throw new Error('Discord member fetch failed unexpectedly.');
    })();

    try {
        return await memberFetchPromise;
    } finally {
        memberFetchPromise = null;
    }
}

// ============================================================
// NICKNAME SYNC DATA
// ============================================================

async function buildNicknameSyncData() {
    const snapshot = await fetchGuildMembers({ force: false });
    if (!snapshot.complete) {
        throw new Error(
            `Discord member cache is incomplete (${snapshot.members.size}/${snapshot.guild.memberCount}); keeping the previous relay snapshot.`
        );
    }

    const members = snapshot.members;
    const set = [];
    const clear = [];

    const links = db.prepare(`
        SELECT discord_id, steam_id, discord_username
        FROM steam_links
    `).all();

    const cleanupRows = db.prepare(`
        SELECT steam_id, discord_username, reason
        FROM nickname_cleanup
    `).all();

    const activeSteamIds = new Set();

    for (const link of links) {
        const member = members.get(link.discord_id);

        if (!member) {
            clear.push({
                steamId: link.steam_id,
                discordId: link.discord_id,
                nickname: getBaseNickname(link.discord_username || link.discord_id),
                reason: 'No longer in Discord'
            });
            continue;
        }

        const username = getMemberUsername(member);
        db.prepare(`
            UPDATE steam_links
            SET discord_username = ?
            WHERE discord_id = ?
        `).run(username, member.id);

        const role = getRosterRole(member);

        if (role) {
            set.push({
                steamId: link.steam_id,
                discordId: member.id,
                nickname: getDesiredNickname(member),
                role
            });
            activeSteamIds.add(link.steam_id);
        } else {
            clear.push({
                steamId: link.steam_id,
                discordId: member.id,
                nickname: getBaseNickname(username),
                reason: 'No longer Recruit or Gump'
            });
        }
    }

    for (const cleanup of cleanupRows) {
        if (activeSteamIds.has(cleanup.steam_id)) continue;
        if (clear.some(item => item.steamId === cleanup.steam_id)) continue;
        if (set.some(item => item.steamId === cleanup.steam_id)) continue;

        clear.push({
            steamId: cleanup.steam_id,
            discordId: null,
            nickname: getBaseNickname(cleanup.discord_username),
            reason: cleanup.reason || 'Discord link removed'
        });
    }

    const states = [...set, ...clear].map(item => ({
        steamId: item.steamId,
        nickname: item.nickname,
        discordId: item.discordId || null,
        role: item.role || null,
        reason: item.reason || null
    }));

    return {
        ok: true,
        generatedAt: Date.now(),
        complete: true,
        memberCount: snapshot.guild.memberCount,
        fetchedMemberCount: members.size,
        states,
        set,
        clear
    };
}

function sha256(value) {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function generateSyncToken() {
    return crypto.randomBytes(32).toString('hex');
}

let relaySnapshot = {
    states: [],
    complete: false,
    memberCount: 0,
    fetchedMemberCount: 0,
    generatedAt: 0,
    updatedAt: 0
};

function bearerToken(req) {
    const value = String(req.headers.authorization || '');
    return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

function sendJson(res, status, data) {
    const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, OPTIONS'
    };

    res.writeHead(status, headers);

    // A 204 response must not contain a response body.
    if (status === 204) {
        res.end();
        return;
    }

    res.end(JSON.stringify(data));
}

function requireClientToken(req, res) {
    const token = bearerToken(req);
    if (!/^[a-f0-9]{64}$/i.test(token)) {
        sendJson(res, 401, { ok: false, error: 'Invalid or revoked sync token.' });
        return null;
    }

    const record = db.prepare(`
        SELECT discord_id AS discordId, steam_id AS steamId
        FROM sync_tokens
        WHERE token_hash = ?
    `).get(sha256(token));

    if (!record || !isValidSteamId(record.steamId)) {
        sendJson(res, 401, { ok: false, error: 'Invalid or revoked sync token.' });
        return null;
    }

    return record;
}

const relayServer = http.createServer((req, res) => {
    try {
        if (req.method === 'OPTIONS') {
            sendJson(res, 204, {});
            return;
        }

        if (req.method === 'GET' && req.url === '/health') {
            sendJson(res, 200, {
                ok: true,
                service: 'discord-steam-nickname-sync',
                discordReady: client.isReady(),
                complete: relaySnapshot.complete,
                states: relaySnapshot.states.length,
                updatedAt: relaySnapshot.updatedAt
            });
            return;
        }

        if (req.method === 'GET' && req.url === '/client/all-state') {
            const record = requireClientToken(req, res);
            if (!record) return;

            if (!relaySnapshot.complete) {
                sendJson(res, 503, {
                    ok: false,
                    error: 'Sync data is not ready. Please try again shortly.',
                    complete: false
                });
                return;
            }

            sendJson(res, 200, {
                ok: true,
                steamId: record.steamId,
                states: relaySnapshot.states,
                complete: true,
                memberCount: relaySnapshot.memberCount,
                fetchedMemberCount: relaySnapshot.fetchedMemberCount,
                generatedAt: relaySnapshot.generatedAt
            });
            return;
        }

        sendJson(res, 404, { ok: false, error: 'Not found.' });
    } catch (error) {
        console.error('HTTP server error:', error);
        sendJson(res, 500, { ok: false, error: error.message || 'Internal server error.' });
    }
});

const PORT = positiveInteger(process.env.PORT, 3000, 65535);
relayServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Railway HTTP relay listening on 0.0.0.0:${PORT}`);
});

async function publishRelaySnapshot() {
    try {
        const data = await buildNicknameSyncData();
        const tokens = db.prepare(`
            SELECT discord_id AS discordId, steam_id AS steamId, token_hash AS tokenHash
            FROM sync_tokens
        `).all();

        // The relay is hosted in this same process, so no external HTTP hop is needed.
        // Keep only the public nickname states in memory; token hashes remain in SQLite.
        relaySnapshot = {
            states: data.states,
            complete: data.complete === true,
            memberCount: data.memberCount,
            fetchedMemberCount: data.fetchedMemberCount,
            generatedAt: data.generatedAt,
            updatedAt: Date.now()
        };

        console.log(`Relay snapshot published locally: ${data.states.length} states, ${tokens.length} tokens.`);
        return true;
    } catch (error) {
        console.error('Relay snapshot publish failed:', error.message || error);
        return false;
    }
}

let relayPublishTimer = null;
function scheduleRelayPublish() {
    clearTimeout(relayPublishTimer);
    relayPublishTimer = setTimeout(() => {
        publishRelaySnapshot().catch(console.error);
    }, 750);
}

// ============================================================
// ROSTER FORMATTING
// ============================================================

function getRosterMembersFromCache(roleId) {
    const guild = client.guilds.cache.get(config.guildId);

    if (!guild) {
        throw new Error(
            `Guild ${config.guildId} was not found in the bot's cached guilds.`
        );
    }

    return Array.from(guild.members.cache.values())
        .filter(member => member.roles.cache.has(roleId))
        .sort((a, b) =>
            a.user.username.localeCompare(
                b.user.username,
                undefined,
                { sensitivity: 'base' }
            )
        );
}

async function getFreshRosterMembers(roleId) {
    let snapshot = await fetchGuildMembers({ force: false });
    if (!snapshot.complete) snapshot = await fetchGuildMembers({ force: true });

    if (!snapshot.complete) {
        throw new Error('Discord member snapshot is incomplete.');
    }

    return Array.from(snapshot.members.values())
        .filter(member => member.roles.cache.has(roleId))
        .sort((a, b) =>
            a.user.username.localeCompare(
                b.user.username,
                undefined,
                { sensitivity: 'base' }
            )
        );
}

function filterRosterMembers(members, filter) {
    if (filter === 'linked') {
        return members.filter(member => Boolean(getLink(member.id)));
    }

    if (filter === 'unlinked') {
        return members.filter(member => !getLink(member.id));
    }

    return members;
}

function rosterFilterRow(prefix, filter) {
    const labels = [
        ['all', 'All'],
        ['linked', 'Linked'],
        ['unlinked', 'Unlinked']
    ];

    return new ActionRowBuilder().addComponents(
        ...labels.map(([value, label]) =>
            new ButtonBuilder()
                .setCustomId(`${prefix}:filter:${value}:0`)
                .setLabel(label)
                .setStyle(
                    filter === value
                        ? ButtonStyle.Primary
                        : ButtonStyle.Secondary
                )
        )
    );
}

function rosterPaginationRow(prefix, filter, page, totalPages) {
    // Never send duplicate custom IDs to Discord. In particular, when there is
    // only one page, both old Previous/Next buttons would resolve to page 0.
    const buttons = [];

    if (page > 0) {
        buttons.push(
            new ButtonBuilder()
                .setCustomId(`${prefix}:prev:${filter}:${page - 1}`)
                .setLabel('Previous')
                .setStyle(ButtonStyle.Secondary)
        );
    }

    if (page < totalPages - 1) {
        buttons.push(
            new ButtonBuilder()
                .setCustomId(`${prefix}:next:${filter}:${page + 1}`)
                .setLabel('Next')
                .setStyle(ButtonStyle.Secondary)
        );
    }

    return buttons.length ? new ActionRowBuilder().addComponents(buttons) : null;
}

function formatRosterLines(members, offset = 0) {
    if (!members.length) {
        return 'No members match this filter.';
    }

    return members.map((member, index) => {
        const link = getLink(member.id);

        if (!link) {
            return `${offset + index + 1}. ⚠️ ${member}\n   Steam: Not Linked`;
        }

        const steamUrl = `https://steamcommunity.com/profiles/${link.steam_id}`;
        return `${offset + index + 1}. ${member}\n   Steam: [${link.steam_id}](<${steamUrl}>)`;
    }).join('\n\n');
}

function buildRosterComponents(prefix, filter, page) {
    const components = [];
    const pagination = rosterPaginationRow(prefix, filter, page.page, page.totalPages);
    if (pagination) components.push(pagination);
    components.push(rosterFilterRow(prefix, filter));
    return components;
}

function buildRosterContent(roleName, members, filteredMembers, page, status = 'cached') {
    const start = page.page * PAGE_SIZE;
    const lines = formatRosterLines(page.items, start);

    const statusLine = status === 'updated'
        ? '✅ **List updated — showing current Discord data.**'
        : status === 'error'
            ? '⚠️ **Unable to refresh the list. Showing cached data.**'
            : '⚠️ **This list is currently cached.**\n🔄 Updating list from Discord…';

    return (
        `**${roleName} Roster**\n` +
        `Total: **${members.length}**  •  Linked: **${members.filter(member => Boolean(getLink(member.id))).length}**  •  Unlinked: **${members.filter(member => !getLink(member.id)).length}**\n\n` +
        `${lines}\n\n` +
        `**Page ${page.page + 1} of ${page.totalPages}**\n\n` +
        statusLine
    );
}

// Each roster message gets a refresh version. When a user presses a
// pagination/filter button, the previous background refresh becomes stale
// and is not allowed to overwrite the newer page/filter.
const rosterRefreshVersions = new Map();

function nextRosterRefreshVersion(messageKey) {
    const next = (rosterRefreshVersions.get(messageKey) || 0) + 1;
    rosterRefreshVersions.set(messageKey, next);
    return next;
}

function isCurrentRosterRefresh(messageKey, version) {
    return rosterRefreshVersions.get(messageKey) === version;
}

async function refreshRosterInteraction(
    interaction,
    roleName,
    roleId,
    prefix,
    filter,
    pageNumber,
    messageKey,
    refreshVersion
) {
    try {
        const members = await getFreshRosterMembers(roleId);

        if (!isCurrentRosterRefresh(messageKey, refreshVersion)) {
            return;
        }
        const filteredMembers = filterRosterMembers(members, filter);
        const page = getPage(filteredMembers, pageNumber, PAGE_SIZE);

        const content = buildRosterContent(
            roleName,
            members,
            filteredMembers,
            page,
            'updated'
        );

        const components = buildRosterComponents(prefix, filter, page);

        await interaction.editReply({
            content: content.length > 2000
                ? content.slice(0, 1990) + '\n…'
                : content,
            components
        });

        if (isCurrentRosterRefresh(messageKey, refreshVersion)) {
            rosterRefreshVersions.delete(messageKey);
        }
    } catch (error) {
        console.error(`Roster background refresh error (${roleName}):`, error);

        if (!isCurrentRosterRefresh(messageKey, refreshVersion)) {
            return;
        }

        try {
            const members = getRosterMembersFromCache(roleId);
            const filteredMembers = filterRosterMembers(members, filter);
            const page = getPage(filteredMembers, pageNumber, PAGE_SIZE);

            const content = buildRosterContent(
                roleName,
                members,
                filteredMembers,
                page,
                'error'
            );

            const components = buildRosterComponents(prefix, filter, page);

            await interaction.editReply({
                content: content.length > 2000
                    ? content.slice(0, 1990) + '\n…'
                    : content,
                components
            });
        } catch (fallbackError) {
            console.error('Roster cached fallback error:', fallbackError);
        }
    }
}

// ============================================================
// SLASH COMMANDS
// ============================================================


const commands = [
    new SlashCommandBuilder()
        .setName('link')
        .setDescription('Link a Discord user to a Steam ID.')
        .addStringOption(option =>
            option
                .setName('steamid')
                .setDescription('17-digit Steam ID')
                .setRequired(true)
        )
        .addUserOption(option =>
            option
                .setName('user')
                .setDescription(
                    'User to link. Only administrators/Consigliere may use this.'
                )
                .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName('unlink')
        .setDescription('Unlink your own Steam ID without removing your roster role.'),
    new SlashCommandBuilder()
        .setName('remove')
        .setDescription('Remove a user Steam link and roster roles.')
        .addUserOption(option =>
            option
                .setName('user')
                .setDescription('User to remove')
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('lookup')
        .setDescription('Look up the Steam ID linked to a Discord user.')
        .addUserOption(option =>
            option
                .setName('user')
                .setDescription('Discord user')
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('steamlookup')
        .setDescription('Look up the Discord user linked to a Steam ID.')
        .addStringOption(option =>
            option
                .setName('steamid')
                .setDescription('17-digit Steam ID')
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('edit')
        .setDescription('Change a user Steam ID.')
        .addUserOption(option =>
            option
                .setName('user')
                .setDescription('Discord user')
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('steamid')
                .setDescription('New 17-digit Steam ID')
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('list')
        .setDescription('List all linked users by current roster status.'),

    new SlashCommandBuilder()
        .setName('listrecruit')
        .setDescription('List every current Recruit, including unlinked users.'),

    new SlashCommandBuilder()
        .setName('listgump')
        .setDescription('List every current Gump, including unlinked users.'),

    new SlashCommandBuilder()
        .setName('stats')
        .setDescription('Show Steam link and roster statistics.'),

    new SlashCommandBuilder()
        .setName('audit')
        .setDescription('View the Steam link audit log.'),

    new SlashCommandBuilder()
        .setName('export')
        .setDescription('Export all current Steam links.'),

    new SlashCommandBuilder()
        .setName('backup')
        .setDescription('Create a backup of the SQLite database.'),

    new SlashCommandBuilder()
        .setName('prune')
        .setDescription('Remove Steam links for users no longer in the server.'),

    new SlashCommandBuilder()
        .setName('sync-setup')
        .setDescription('Generate a personal Steam nickname sync token.')
];

// ============================================================
// COMMAND HANDLERS
// ============================================================

async function handleLink(interaction) {
    const steamId = interaction.options.getString('steamid');
    const target = interaction.options.getMember('user');

    if (!isValidSteamId(steamId)) {
        await interaction.reply({
            content: 'Steam ID must be exactly 17 digits.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    if (target) {
        if (!isPrivileged(interaction.member)) {
            await interaction.reply({
                content:
                    'Only an Administrator or Consigliere can link another user.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }
    } else {
        if (!canSelfLink(interaction.member)) {
            await interaction.reply({
                content:
                    'You must have the Recruit or Gump role to link your own Steam ID.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }
    }

    const member = target || interaction.member;

    const existingDiscordLink = getLink(member.id);

    if (existingDiscordLink) {
        await interaction.reply({
            content:
                `That user is already linked to Steam ID \`${existingDiscordLink.steam_id}\`. Use \`/edit\` to change it.`,
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    const existingSteamLink = getLinkBySteamId(steamId);

    if (existingSteamLink) {
        await interaction.reply({
            content:
                `That Steam ID is already linked to <@${existingSteamLink.discord_id}>.`,
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    const saveLink = db.transaction(() => {
        db.prepare(`
            INSERT INTO steam_links (
                discord_id, steam_id, discord_username, linked_at
            )
            VALUES (?, ?, ?, ?)
        `).run(member.id, steamId, member.user.username, Date.now());

        db.prepare(`UPDATE sync_tokens SET steam_id = ? WHERE discord_id = ?`).run(steamId, member.id);

        addAudit({
            action: 'LINK',
            actorId: interaction.user.id,
            targetId: member.id,
            newSteamId: steamId
        });

        db.prepare(`DELETE FROM nickname_cleanup WHERE steam_id = ?`).run(steamId);
        db.prepare(`DELETE FROM link_prompt_notifications WHERE discord_id = ?`).run(member.id);
    });

    saveLink();
    await interaction.reply({
        content:
            `Linked ${member} to Steam ID \`${steamId}\`.`,
        flags: MessageFlags.Ephemeral
    });

    scheduleRelayPublish();
}

async function handleUnlink(interaction) {
    const link = getLink(interaction.user.id);

    if (!link) {
        await interaction.reply({
            content: 'You do not currently have a Steam ID linked.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    const unlink = db.transaction(() => {
        queueNicknameCleanup(link.steam_id, interaction.user.username, 'User unlinked their own Steam link');
        db.prepare(`DELETE FROM steam_links WHERE discord_id = ?`).run(interaction.user.id);
        db.prepare(`UPDATE sync_tokens SET steam_id = '' WHERE discord_id = ?`).run(interaction.user.id);
        addAudit({
            action: 'UNLINK',
            actorId: interaction.user.id,
            targetId: interaction.user.id,
            oldSteamId: link.steam_id,
            details: 'User unlinked their own Steam link'
        });
    });

    unlink();
    await interaction.reply({
        content: `Unlinked your Steam ID \`${link.steam_id}\`. Your Recruit/Gump role was left unchanged.`,
        flags: MessageFlags.Ephemeral
    });

    scheduleRelayPublish();
}
async function handleRemove(interaction) {
    if (!isPrivileged(interaction.member)) {
        await interaction.reply({
            content:
                'Only an Administrator or Consigliere can remove Steam links.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    const member = interaction.options.getMember('user');

    if (!member) {
        await interaction.reply({
            content: 'That user could not be found in the server.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    const link = getLink(member.id);

    if (!link) {
        await interaction.reply({
            content: `${member} does not have a Steam ID linked.`,
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`confirmremove:${member.id}`)
            .setLabel('Confirm Remove')
            .setStyle(ButtonStyle.Danger),

        new ButtonBuilder()
            .setCustomId(`cancelremove:${member.id}`)
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({
        content:
            `Are you sure you want to remove the Steam link for ${member}?\n\n` +
            `Steam ID: \`${link.steam_id}\`\n\n` +
            `This will also remove the Recruit and Gump roles. Other roles will remain.`,
        components: [row],
        flags: MessageFlags.Ephemeral
    });
}

async function performRemove(interaction, targetId) {
    const member = await interaction.guild.members.fetch(targetId);
    const link = getLink(targetId);

    if (!link) {
        await interaction.editReply({
            content: 'That user no longer has a Steam link.',
            components: []
        });
        return;
    }

    const rolesToRemove = [];

    if (member.roles.cache.has(ROLE_RECRUIT)) {
        rolesToRemove.push(ROLE_RECRUIT);
    }

    if (member.roles.cache.has(ROLE_GUMP)) {
        rolesToRemove.push(ROLE_GUMP);
    }

    // Change Discord roles first. If Discord rejects the role operation,
    // leave the database link intact so the two systems cannot silently
    // become inconsistent.
    if (rolesToRemove.length) {
        await member.roles.remove(rolesToRemove);
    }

    const removeLink = db.transaction(() => {
        queueNicknameCleanup(link.steam_id, member.user.username, 'Steam link removed');
        db.prepare(`DELETE FROM steam_links WHERE discord_id = ?`).run(targetId);
        db.prepare(`DELETE FROM sync_tokens WHERE discord_id = ?`).run(targetId);
        addAudit({ action: 'REMOVE', actorId: interaction.user.id, targetId, oldSteamId: link.steam_id });
    });

    removeLink();

    await interaction.editReply({
        content:
            `Removed the Steam link for ${member} and removed their Recruit/Gump roles.`,
        components: []
    });

    scheduleRelayPublish();
}

async function handleLookup(interaction) {
    const member = interaction.options.getMember('user');

    if (!member) {
        await interaction.reply({
            content: 'That user could not be found.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    const link = getLink(member.id);

    if (!link) {
        await interaction.reply({
            content: `${member} does not have a Steam ID linked.`,
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    await interaction.reply({
        content:
            `${member} is linked to Steam ID \`${link.steam_id}\`.`,
        flags: MessageFlags.Ephemeral
    });
}

async function handleSteamLookup(interaction) {
    const steamId = interaction.options.getString('steamid');

    if (!isValidSteamId(steamId)) {
        await interaction.reply({
            content: 'Steam ID must be exactly 17 digits.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    const link = getLinkBySteamId(steamId);

    if (!link) {
        await interaction.reply({
            content: `Steam ID \`${steamId}\` is not linked to anyone.`,
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    await interaction.reply({
        content:
            `Steam ID \`${steamId}\` is linked to <@${link.discord_id}>.`,
        flags: MessageFlags.Ephemeral
    });
}

async function handleEdit(interaction) {
    if (!isPrivileged(interaction.member)) {
        await interaction.reply({
            content:
                'Only an Administrator or Consigliere can edit Steam IDs.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    const member = interaction.options.getMember('user');
    const newSteamId = interaction.options.getString('steamid');

    if (!member) {
        await interaction.reply({
            content: 'That user could not be found.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    if (!isValidSteamId(newSteamId)) {
        await interaction.reply({
            content: 'Steam ID must be exactly 17 digits.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    const link = getLink(member.id);

    if (!link) {
        await interaction.reply({
            content:
                `${member} is not currently linked. Use \`/link\` instead.`,
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    const existing = getLinkBySteamId(newSteamId);

    if (existing && existing.discord_id !== member.id) {
        await interaction.reply({
            content:
                `That Steam ID is already linked to <@${existing.discord_id}>.`,
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    if (link.steam_id === newSteamId) {
        await interaction.reply({
            content: 'That is already their current Steam ID.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    const editLink = db.transaction(() => {
        queueNicknameCleanup(link.steam_id, member.user.username, 'Steam ID changed');
        db.prepare(`UPDATE steam_links SET steam_id = ?, discord_username = ? WHERE discord_id = ?`).run(newSteamId, member.user.username, member.id);
        db.prepare(`UPDATE sync_tokens SET steam_id = ? WHERE discord_id = ?`).run(newSteamId, member.id);
        addAudit({ action: 'EDIT', actorId: interaction.user.id, targetId: member.id, oldSteamId: link.steam_id, newSteamId });
        db.prepare(`DELETE FROM nickname_cleanup WHERE steam_id = ?`).run(newSteamId);
    });

    editLink();
    await interaction.reply({
        content:
            `Changed ${member}'s Steam ID from \`${link.steam_id}\` to \`${newSteamId}\`.`,
        flags: MessageFlags.Ephemeral
    });

    scheduleRelayPublish();
}

function buildListPages(rows, members) {
    const groups = { Gump: [], Recruit: [], Unassigned: [] };
    for (const row of rows) {
        const member = members.get(row.discord_id);
        const role = member ? (getRosterRole(member) || 'Unassigned') : 'Unassigned';
        groups[role].push({ member, steamId: row.steam_id, discordId: row.discord_id });
    }
    const lines = [];
    for (const role of ['Gump', 'Recruit', 'Unassigned']) {
        const values = groups[role];
        lines.push(`**${role} (${values.length})**`);
        if (!values.length) { lines.push('None.'); continue; }
        for (const item of values) lines.push(item.member ? `• ${item.member} — \`${item.steamId}\`` : `• ⚠️ <@${item.discordId}> — \`${item.steamId}\``);
    }
    const pages=[]; let current='';
    for (const line of lines) {
        const candidate=current ? `${current}\n\n${line}` : line;
        if (candidate.length <= DISCORD_SAFE_CONTENT_LIMIT) { current=candidate; continue; }
        if (current) pages.push(current);
        current=truncateDiscordContent(line);
    }
    if (current) pages.push(current);
    return pages.length ? pages : ['No Steam links found.'];
}

function listPaginationRow(page, totalPages) {
    const row = new ActionRowBuilder();
    if (page > 0) row.addComponents(new ButtonBuilder().setCustomId(`list:page:${page - 1}`).setLabel('Previous').setStyle(ButtonStyle.Secondary));
    if (page < totalPages - 1) row.addComponents(new ButtonBuilder().setCustomId(`list:page:${page + 1}`).setLabel('Next').setStyle(ButtonStyle.Secondary));
    return row.components.length ? row : null;
}

async function renderListInteraction(interaction, pageNumber = 0) {
    if (!canSelfLink(interaction.member) && !isPrivileged(interaction.member)) {
        await interaction.reply({ content: 'You need the Recruit, Gump, Administrator, or Consigliere role to use this command.', flags: MessageFlags.Ephemeral });
        return;
    }

    if (interaction.isButton()) {
        await interaction.deferUpdate();
    } else if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    let snapshot = await fetchGuildMembers({ force: false });
    if (!snapshot.complete) snapshot = await fetchGuildMembers({ force: true });
    if (!snapshot.complete) throw new Error('Discord member snapshot is incomplete.');
    const rows = db.prepare('SELECT discord_id, steam_id FROM steam_links ORDER BY discord_id').all();
    const pages = buildListPages(rows, snapshot.members);
    const page = Math.max(0, Math.min(Number.isInteger(pageNumber) ? pageNumber : 0, pages.length - 1));
    const content = pages[page] + (pages.length > 1 ? `\n\n**Page ${page + 1} of ${pages.length}**` : '');
    const row = listPaginationRow(page, pages.length);
    const payload = { content: truncateDiscordContent(content), components: row ? [row] : [] };
    await interaction.editReply(payload);
}

async function handleList(interaction) {
    await renderListInteraction(interaction, 0);
}


async function handleRoleList(interaction, roleName, roleId, prefix, filter = 'all', pageNumber = 0) {
    const allowed =
        canSelfLink(interaction.member) ||
        isPrivileged(interaction.member);

    if (!allowed) {
        const response = {
            content: 'You need the Recruit, Gump, Administrator, or Consigliere role to use this command.',
            flags: MessageFlags.Ephemeral
        };

        if (interaction.isButton()) {
            await interaction.reply(response);
        } else {
            await interaction.reply(response);
        }
        return;
    }

    // Show the cached roster immediately so the command feels instant.
    // A fresh Discord member snapshot is loaded in the background and the
    // same message is automatically updated when it finishes.
    const members = getRosterMembersFromCache(roleId);
    const filteredMembers = filterRosterMembers(members, filter);
    const page = getPage(filteredMembers, pageNumber, PAGE_SIZE);

    const content = buildRosterContent(
        roleName,
        members,
        filteredMembers,
        page,
        'cached'
    );

    const components = buildRosterComponents(prefix, filter, page);

    const payload = {
        content: content.length > 2000
            ? content.slice(0, 1990) + '\n…'
            : content,
        components
    };

    if (interaction.isButton()) {
        await interaction.update(payload);
    } else {
        await interaction.reply({
            ...payload,
            flags: MessageFlags.Ephemeral
        });
    }

    // Do not make the user wait for the full Discord member fetch.
    // Once it completes, edit this same roster message automatically.
    // Use the Discord message ID so later button clicks can invalidate an
    // older background refresh for the same roster message.
    let messageKey;

    try {
        const replyMessage = interaction.isButton()
            ? interaction.message
            : await interaction.fetchReply();

        messageKey = replyMessage?.id || interaction.id;
    } catch {
        messageKey = interaction.message?.id || interaction.id;
    }

    const refreshVersion = nextRosterRefreshVersion(messageKey);

    refreshRosterInteraction(
        interaction,
        roleName,
        roleId,
        prefix,
        filter,
        pageNumber,
        messageKey,
        refreshVersion
    ).catch(error => {
        console.error('Unexpected roster background refresh error:', error);
    });
}

async function handleStats(interaction) {
    if (!isPrivileged(interaction.member)) {
        await interaction.reply({
            content: 'Only an Administrator or Consigliere can view statistics.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let snapshot = await fetchGuildMembers({ force: false });
    if (!snapshot.complete) snapshot = await fetchGuildMembers({ force: true });
    const guild = snapshot.guild;
    const members = snapshot.members;

    const linked = db.prepare(`
        SELECT COUNT(*) AS count
        FROM steam_links
    `).get().count;

    let gumpTotal = 0;
    let recruitTotal = 0;
    let gumpLinkedCount = 0;
    let recruitLinkedCount = 0;
    let unassignedLinked = 0;

    for (const row of db.prepare(`
        SELECT discord_id
        FROM steam_links
    `).all()) {
        const member = members.get(row.discord_id);

        if (!member) {
            unassignedLinked++;
            continue;
        }

        if (member.roles.cache.has(ROLE_GUMP)) {
            gumpLinkedCount++;
        } else if (member.roles.cache.has(ROLE_RECRUIT)) {
            recruitLinkedCount++;
        } else {
            unassignedLinked++;
        }
    }

    gumpTotal = members.filter(
        member => member.roles.cache.has(ROLE_GUMP)
    ).size;

    recruitTotal = members.filter(
        member => member.roles.cache.has(ROLE_RECRUIT)
    ).size;

    const cleanupCount = db.prepare(`
        SELECT COUNT(*) AS count
        FROM nickname_cleanup
    `).get().count;

    await interaction.editReply({
        content:
            `**Roster / Steam Stats**\n\n` +
            `Gump members: **${gumpTotal}**\n` +
            `Gump linked: **${gumpLinkedCount}**\n\n` +
            `Recruit members: **${recruitTotal}**\n` +
            `Recruit linked: **${recruitLinkedCount}**\n\n` +
            `Linked but unassigned/absent: **${unassignedLinked}**\n` +
            `Total Steam links: **${linked}**\n` +
            `Nickname cleanup queue: **${cleanupCount}**`
    });
}

function formatAuditEntry(row) {
    const when = `<t:${Math.floor(row.timestamp / 1000)}:f>`;
    let details = `**${row.action}** — <@${row.target_id}> — ${when}`;
    if (row.old_steam_id) details += `\nOld: \`${row.old_steam_id}\``;
    if (row.new_steam_id) details += `\nNew: \`${row.new_steam_id}\``;
    if (row.details) details += `\n${row.details}`;
    return truncateDiscordContent(details);
}

function buildAuditPages(rows) {
    const pages=[]; let current='';
    for (const row of rows) {
        const entry=formatAuditEntry(row);
        const candidate=current ? `${current}\n\n${entry}` : entry;
        if (candidate.length <= DISCORD_SAFE_CONTENT_LIMIT) { current=candidate; continue; }
        if (current) pages.push(current);
        current=entry;
    }
    if (current) pages.push(current);
    return pages.length ? pages : ['No audit entries.'];
}

async function renderAuditInteraction(interaction, pageNumber = 0) {
    if (interaction.isButton()) {
        await interaction.deferUpdate();
    } else if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    const rows=db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(MAX_AUDIT_ENTRIES);
    const pages=buildAuditPages(rows);
    const page=Math.max(0, Math.min(Number.isInteger(pageNumber) ? pageNumber : 0, pages.length-1));
    const content=pages[page] + (pages.length > 1 ? `\n\n**Page ${page+1} of ${pages.length}**` : '');
    const row=paginationRow('audit', page, pages.length);
    const payload={content:truncateDiscordContent(content),components:row?[row]:[]};
    await interaction.editReply(payload);
}

async function handleAudit(interaction) {
    if (!isPrivileged(interaction.member)) {
        await interaction.reply({ content: 'Only an Administrator or Consigliere can view the audit log.', flags: MessageFlags.Ephemeral });
        return;
    }
    await renderAuditInteraction(interaction, 0);
}


async function handleExport(interaction) {
    if (!isPrivileged(interaction.member)) {
        await interaction.reply({
            content:
                'Only an Administrator or Consigliere can export Steam links.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    const rows = db.prepare(`
        SELECT
            discord_id,
            discord_username,
            steam_id,
            linked_at
        FROM steam_links
        ORDER BY discord_username COLLATE NOCASE
    `).all();

    const header =
        'discord_id,discord_username,steam_id,linked_at';

    const csvRows = rows.map(row =>
        [
            row.discord_id,
            `"${String(row.discord_username || '').replace(/"/g, '""')}"`,
            row.steam_id,
            new Date(row.linked_at).toISOString()
        ].join(',')
    );

    const csv = [header, ...csvRows].join('\n');

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const filePath = path.join(
        __dirname,
        `steam-export-${Date.now()}.csv`
    );

    fs.writeFileSync(filePath, csv, 'utf8');

    await interaction.editReply({
        content: `Export created with ${rows.length} link(s).`,
        files: [filePath]
    });

    setTimeout(() => {
        try {
            fs.unlinkSync(filePath);
        } catch {
            // Ignore cleanup errors.
        }
    }, 60_000);
}

async function handleBackup(interaction) {
    if (!isPrivileged(interaction.member)) {
        await interaction.reply({
            content:
                'Only an Administrator or Consigliere can create backups.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    // Keep backups beside the persistent SQLite database so Railway volume
    // backups survive deployments/restarts.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const backupDir = path.join(path.dirname(databasePath), 'backups');

    fs.mkdirSync(backupDir, { recursive: true });

    const backupPath = path.join(
        backupDir,
        `database-${Date.now()}.sqlite`
    );

    await db.backup(backupPath);

    const backupFiles = fs.readdirSync(backupDir)
        .filter(name => /^database-\d+\.sqlite$/.test(name))
        .sort((a, b) => Number(b.match(/^database-(\d+)\.sqlite$/)?.[1] || 0) - Number(a.match(/^database-(\d+)\.sqlite$/)?.[1] || 0));

    for (const oldBackup of backupFiles.slice(BACKUP_RETENTION)) {
        try {
            fs.unlinkSync(path.join(backupDir, oldBackup));
        } catch (error) {
            console.warn(`Could not remove old backup ${oldBackup}: ${error.message || error}`);
        }
    }

    await interaction.editReply({
        content:
            `Database backup created:\n\`${path.relative(path.dirname(databasePath), backupPath)}\``
    });
}

async function handleSyncSetup(interaction) {
    const existing = getLink(interaction.user.id);

    if (!existing) {
        await interaction.reply({
            content: 'You must have a linked Steam account before generating a sync token. Use `/link` first.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    if (!canSelfLink(interaction.member) && !isPrivileged(interaction.member)) {
        await interaction.reply({
            content: 'You need the Recruit, Gump, Administrator, or Consigliere role to use this command.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    const token = generateSyncToken();
    const tokenHash = sha256(token);

    const saveSyncToken = db.transaction(() => {
        db.prepare(`
            INSERT INTO sync_tokens (discord_id, steam_id, token_hash, created_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(discord_id)
            DO UPDATE SET
                steam_id = excluded.steam_id,
                token_hash = excluded.token_hash,
                created_at = excluded.created_at
        `).run(interaction.user.id, existing.steam_id, tokenHash, Date.now());
    });

    saveSyncToken();

    scheduleRelayPublish();

    await interaction.reply({
        content:
            '**Your new Steam sync token**\n\n' +
            `\`${token}\`\n\n` +
            'Copy it into the Tampermonkey **Set Sync Token** button. This token is shown only once. Running `/sync-setup` again will replace the old token.',
        flags: MessageFlags.Ephemeral
    });
}

async function handlePrune(interaction) {
    if (!isPrivileged(interaction.member)) {
        await interaction.reply({
            content:
                'Only an Administrator or Consigliere can prune Steam links.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const snapshot = await fetchGuildMembers({ force: true });
    const members = snapshot.members;

    const rows = db.prepare(`
        SELECT
            discord_id,
            steam_id,
            discord_username
        FROM steam_links
    `).all();

    const removed = [];

    const transaction = db.transaction(() => {
        for (const row of rows) {
            if (members.has(row.discord_id)) {
                continue;
            }

            queueNicknameCleanup(
                row.steam_id,
                row.discord_username || row.discord_id,
                'User no longer in Discord'
            );

            db.prepare(`
                DELETE FROM steam_links
                WHERE discord_id = ?
            `).run(row.discord_id);

            db.prepare(`
                DELETE FROM sync_tokens
                WHERE discord_id = ?
            `).run(row.discord_id);

            addAudit({
                action: 'PRUNE',
                actorId: interaction.user.id,
                targetId: row.discord_id,
                oldSteamId: row.steam_id,
                details: 'User no longer in server'
            });

            removed.push(row);
        }
    });

    transaction();

    await interaction.editReply({
        content:
            removed.length
                ? `Pruned **${removed.length}** user(s). Their Steam IDs were added to the nickname cleanup queue.`
                : 'No stale Steam links were found.'
    });

    scheduleRelayPublish();
}


const linkPromptInFlight = new Set();

function getPromptDay(timestamp = Date.now()) {
    try {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: config.settings.linkPromptTimezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).format(new Date(timestamp));
    } catch {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: 'UTC',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).format(new Date(timestamp));
    }
}

function wasPromptedToday(discordId) {
    const record = db.prepare(
        'SELECT notified_at FROM link_prompt_notifications WHERE discord_id = ?'
    ).get(discordId);

    if (!record) return false;

    return getPromptDay(record.notified_at) === getPromptDay();
}

async function sendSteamLinkPrompt(member) {
    if (!member || member.user?.bot) return false;
    if (!hasRosterRole(member)) return false;
    if (getLink(member.id)) return false;
    if (wasPromptedToday(member.id)) return false;
    if (linkPromptInFlight.has(member.id)) return false;

    linkPromptInFlight.add(member.id);

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('self-link-now')
            .setLabel('Link Now')
            .setEmoji('🔗')
            .setStyle(ButtonStyle.Primary)
    );

    try {
        await member.send({
            content:
                '⚠️ **You are not linked to Steam yet.**\n\n' +
                'Please link your Steam account using the button below.\n\n' +
                '**This is essential for being authorized on turrets.**',
            components: [row]
        });

        db.prepare(`
            INSERT INTO link_prompt_notifications (discord_id, notified_at)
            VALUES (?, ?)
            ON CONFLICT(discord_id)
            DO UPDATE SET notified_at = excluded.notified_at
        `).run(member.id, Date.now());

        console.log('Sent daily Steam link prompt to ' + member.user.username + ' (' + member.id + ').');
        return true;
    } catch (error) {
        console.warn(
            'Could not DM Steam link prompt to ' + member.user.username + ' (' + member.id + '): ' + (error.message || error)
        );
        return false;
    } finally {
        linkPromptInFlight.delete(member.id);
    }
}

async function handleSelfLinkButton(interaction) {
    const modal = new ModalBuilder()
        .setCustomId('self-link-modal')
        .setTitle('Link Your Steam Account');

    const steamIdInput = new TextInputBuilder()
        .setCustomId('steamid')
        .setLabel('Steam ID')
        .setPlaceholder('Enter your 17-digit Steam ID')
        .setStyle(TextInputStyle.Short)
        .setMinLength(17)
        .setMaxLength(17)
        .setRequired(true);

    modal.addComponents(
        new ActionRowBuilder().addComponents(steamIdInput)
    );

    await interaction.showModal(modal);
}

async function handleSelfLinkModal(interaction) {
    const steamId = interaction.fields.getTextInputValue('steamid').trim();

    if (!isValidSteamId(steamId)) {
        await interaction.editReply({
            content: 'Steam ID must be exactly 17 digits.'
        });
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guild = client.guilds.cache.get(config.guildId);

    if (!guild) {
        await interaction.editReply({
            content: 'The Discord server could not be found. Please try again later.'
        });
        return;
    }

    const member = await guild.members.fetch(interaction.user.id).catch(() => null);

    if (!member) {
        await interaction.editReply({
            content: 'You could not be found in the Discord server.'
        });
        return;
    }

    if (!canSelfLink(member)) {
        await interaction.editReply({
            content: 'You must have the Recruit or Gump role to link your Steam account.'
        });
        return;
    }

    const existingDiscordLink = getLink(member.id);

    if (existingDiscordLink) {
        await interaction.editReply({
            content: 'You are already linked to Steam ID `' + existingDiscordLink.steam_id + '`.'
        });
        return;
    }

    const existingSteamLink = getLinkBySteamId(steamId);

    if (existingSteamLink) {
        await interaction.editReply({
            content: 'That Steam ID is already linked to <@' + existingSteamLink.discord_id + '>.'
        });
        return;
    }

    const saveSelfLink = db.transaction(() => {
        db.prepare(
            'INSERT INTO steam_links (discord_id, steam_id, discord_username, linked_at) VALUES (?, ?, ?, ?)'
        ).run(
            member.id,
            steamId,
            member.user.username,
            Date.now()
        );

        addAudit({
            action: 'LINK',
            actorId: interaction.user.id,
            targetId: member.id,
            newSteamId: steamId
        });

        db.prepare(
            'DELETE FROM nickname_cleanup WHERE steam_id = ?'
        ).run(steamId);

        db.prepare(
            'DELETE FROM link_prompt_notifications WHERE discord_id = ?'
        ).run(member.id);

        db.prepare(
            'UPDATE sync_tokens SET steam_id = ? WHERE discord_id = ?'
        ).run(steamId, member.id);
    });

    saveSelfLink();

    await interaction.editReply({
        content: '✅ **Steam account linked successfully!**\n\nSteam ID: `' + steamId + '`'
    });

    scheduleRelayPublish();
}
// ============================================================
// BUTTON HANDLING
// ============================================================

async function handleListPage(interaction, type, filter, pageNumber) {
    const roleName = type === 'listrecruit' ? 'Recruit' : 'Gump';
    const roleId = type === 'listrecruit' ? ROLE_RECRUIT : ROLE_GUMP;

    await handleRoleList(
        interaction,
        roleName,
        roleId,
        type,
        filter,
        pageNumber
    );
}

async function handleAuditPage(interaction, pageNumber) {
    await renderAuditInteraction(interaction, pageNumber);
}


// ============================================================
// DISCORD EVENTS
// ============================================================

async function scanOnlineMembersForLinkPrompts() {
    try {
        const snapshot = await fetchGuildMembers({ force: false });
        if (!snapshot.complete) {
            console.warn(
                `Startup Steam link prompt scan deferred because the member cache is incomplete (${snapshot.members.size}/${snapshot.guild.memberCount}).`
            );
            setTimeout(() => {
                scanOnlineMembersForLinkPrompts().catch(error => {
                    console.error('Deferred Steam link prompt scan failed:', error);
                });
            }, 30_000);
            return;
        }

        let checked = 0;
        let prompted = 0;

        for (const member of snapshot.members.values()) {
            if (member.user?.bot) continue;
            if (!hasRosterRole(member)) continue;
            const status = member.presence?.status || 'offline';
            if (status === 'offline') continue;

            checked++;
            if (await sendSteamLinkPrompt(member)) prompted++;
        }

        console.log(`Daily Steam link prompt scan complete: checked ${checked} online roster member(s), sent ${prompted} prompt(s).`);
    } catch (error) {
        console.error('Online Steam link prompt scan failed:', error);
    }
}

client.once('clientReady', async () => {
    console.log(`Logged in as ${client.user.tag}`);

    try {
        await client.application.commands.set(
            commands.map(command => command.toJSON()),
            config.guildId
        );

        console.log('Slash commands registered.');
    } catch (error) {
        console.error('Failed to register slash commands:', error);
    }

    // Start the recurring relay timer immediately. Initial sync/prompt work
    // is intentionally asynchronous so a slow guild member fetch cannot
    // block the bot's normal event loop setup.
    setInterval(() => publishRelaySnapshot().catch(console.error), 60_000);

    publishRelaySnapshot().catch(error => {
        console.error('Initial relay snapshot failed:', error);
    });

    scanOnlineMembersForLinkPrompts().catch(error => {
        console.error('Initial Steam link prompt scan failed:', error);
    });
});

client.on('interactionCreate', async interaction => {
    try {
        if (interaction.isChatInputCommand()) {
            switch (interaction.commandName) {
                case 'link':
                    await handleLink(interaction);
                    break;

                case 'unlink':
                    await handleUnlink(interaction);
                    break;

                case 'remove':
                    await handleRemove(interaction);
                    break;

                case 'lookup':
                    await handleLookup(interaction);
                    break;

                case 'steamlookup':
                    await handleSteamLookup(interaction);
                    break;

                case 'edit':
                    await handleEdit(interaction);
                    break;

                case 'list':
                    await handleList(interaction);
                    break;

                case 'listrecruit':
                    await handleRoleList(
                        interaction,
                        'Recruit',
                        ROLE_RECRUIT,
                        'listrecruit',
                        'all',
                        0
                    );
                    break;

                case 'listgump':
                    await handleRoleList(
                        interaction,
                        'Gump',
                        ROLE_GUMP,
                        'listgump',
                        'all',
                        0
                    );
                    break;

                case 'stats':
                    await handleStats(interaction);
                    break;

                case 'audit':
                    await handleAudit(interaction);
                    break;

                case 'export':
                    await handleExport(interaction);
                    break;

                case 'backup':
                    await handleBackup(interaction);
                    break;

                case 'prune':
                    await handlePrune(interaction);
                    break;

                case 'sync-setup':
                    await handleSyncSetup(interaction);
                    break;
            }

            return;
        }

        if (interaction.isModalSubmit()) {
            const id = interaction.customId;

            if (id === 'self-link-modal') {
                await handleSelfLinkModal(interaction);
                return;
            }
        }

        if (interaction.isButton()) {
            const id = interaction.customId;

            if (id === 'self-link-now') {
                await handleSelfLinkButton(interaction);
                return;
            }

            // Confirmation buttons MUST be handled before generic
            // pagination/button handling.
            if (id.startsWith('confirmremove:')) {
                if (!isPrivileged(interaction.member)) {
                    await interaction.reply({
                        content:
                            'Only an Administrator or Consigliere can confirm removals.',
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }

                const targetId = id.split(':')[1];

                await interaction.deferUpdate();
                await performRemove(interaction, targetId);
                return;
            }

            if (id.startsWith('cancelremove:')) {
                await interaction.update({
                    content: 'Removal cancelled.',
                    components: []
                });
                return;
            }

            if (
                id.startsWith('listrecruit:prev:') ||
                id.startsWith('listrecruit:next:') ||
                id.startsWith('listgump:prev:') ||
                id.startsWith('listgump:next:')
            ) {
                const [type, direction, filter, pageText] = id.split(':');
                const page = Number(pageText);

                await handleListPage(
                    interaction,
                    type,
                    filter,
                    Number.isFinite(page) ? page : 0
                );
                return;
            }

            if (id.startsWith('listrecruit:filter:') || id.startsWith('listgump:filter:')) {
                const [type, , filter] = id.split(':');

                await handleListPage(
                    interaction,
                    type,
                    filter,
                    0
                );
                return;
            }

            if (id.startsWith('list:page:')) {
                const page = Number(id.split(':')[2]);
                await renderListInteraction(interaction, Number.isFinite(page) ? page : 0);
                return;
            }

            if (id.startsWith('audit:page:')) {
                const page = Number(
                    id.split(':')[2]
                );

                await handleAuditPage(
                    interaction,
                    page
                );
                return;
            }
        }
    } catch (error) {
        console.error('Interaction error:', error);

        const message = {
            content:
                'Something went wrong while processing that command.',
            flags: MessageFlags.Ephemeral
        };

        try {
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(message);
            } else {
                await interaction.reply(message);
            }
        } catch {
            // Ignore secondary Discord errors.
        }
    }
});

client.on('presenceUpdate', async (oldPresence, newPresence) => {
    try {
        const guild = newPresence.guild;

        if (!guild || guild.id !== config.guildId) return;

        const oldStatus = oldPresence?.status || 'offline';
        const newStatus = newPresence.status || 'offline';

        if (oldStatus !== 'offline' || newStatus === 'offline') return;

        const member =
            newPresence.member ||
            guild.members.cache.get(newPresence.userId) ||
            await guild.members.fetch(newPresence.userId).catch(() => null);

        if (!member) return;

        await sendSteamLinkPrompt(member);
    } catch (error) {
        console.error('Presence link-prompt error:', error);
    }
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
    const link = getLink(newMember.id);

    if (link) {
        db.prepare(`
            UPDATE steam_links
            SET discord_username = ?
            WHERE discord_id = ?
        `).run(
            newMember.user.username,
            newMember.id
        );
    }

    scheduleRelayPublish();
});

client.on('guildMemberAdd', async member => {
    const link = getLink(member.id);

    if (link) {
        db.prepare(`
            UPDATE steam_links
            SET discord_username = ?
            WHERE discord_id = ?
        `).run(
            member.user.username,
            member.id
        );
    }

    scheduleRelayPublish();
});

client.on('guildMemberRemove', member => {
    // A member leaving the server should immediately trigger a relay refresh
    // so their linked Steam nickname can be cleared without waiting for the
    // 60-second periodic snapshot.
    scheduleRelayPublish();
});

client.login(process.env.DISCORD_TOKEN);
