// ==UserScript==

// @name         Discord Steam Nickname Sync
// @namespace    discord-steam-sync
// @version      11.51
// @description  Sync Steam friend local nicknames from Discord roles.
// @homepageURL  https://github.com/RustyGumpers/steam-link
// @supportURL   https://github.com/RustyGumpers/steam-link/issues
// @updateURL    https://raw.githubusercontent.com/RustyGumpers/steam-link/main/Discord-Steam-Nickname-Sync.user.js
// @downloadURL  https://raw.githubusercontent.com/RustyGumpers/steam-link/main/Discord-Steam-Nickname-Sync.user.js
// @match        https://steamcommunity.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @connect      steam-link-production.up.railway.app
// @connect      steamcommunity.com
// @connect      api.steampowered.com
// @run-at       document-idle
// ==/UserScript==

(() => {
    'use strict';

    const SYNC_API_URL = 'https://steam-link-production.up.railway.app';
    const TOKEN_KEY = 'discordSteamSyncToken';
    const STEAM_API_KEY_STORAGE = 'discordSteamSyncSteamApiKeyV1';
    const GUMP_CUSTOM_PREFIX_KEY = 'discordSteamSyncGumpPrefixV1';
    const RECRUIT_CUSTOM_PREFIX_KEY = 'discordSteamSyncRecruitPrefixV1';
    const LEGACY_CUSTOM_PREFIX_KEY = 'discordSteamSyncCustomPrefixV1';
    const MANAGED_PREFIXES_KEY = 'discordSteamSyncManagedPrefixesV1';
    const MANAGED_NICKNAMES_KEY = 'discordSteamSyncManagedNicknamesV1';
    const LAST_COMPLETED_SIGNATURE_KEY = 'discordSteamSyncLastCompletedSignatureV10';
    const AUTO_SYNC_PAUSED_AFTER_CLEAR_KEY = 'discordSteamSyncAutoSyncPausedAfterClearV1';
    const FRIEND_REQUESTS_KEY = 'discordSteamSyncFriendRequestsV1';
    const FRIEND_REQUEST_COOLDOWN_MS = 24 * 60 * 60 * 1000;
    const POLL_INTERVAL_MS = 15000;
    const FRIEND_COVERAGE_RECHECK_MS = 5 * 60 * 1000;
    const REQUEST_TIMEOUT_MS = 15000;
    const STEAM_API_KEY_PATTERN = /^[a-f0-9]{32}$/i;
    const MAX_NICKNAME_LENGTH = 32;

    let stopRequested = false;
    let syncRunning = false;
    let pollTimer = null;
    let lastFriendCoverageCheckAt = 0;

    function readStoredValue(key, fallback = '') {
        try {
            const value = GM_getValue(key, undefined);
            if (value !== undefined && value !== null) return value;
        } catch {}
        try {
            const value = localStorage.getItem(key);
            return value === null ? fallback : value;
        } catch {}
        return fallback;
    }

    function writeStoredValue(key, value) {
        // Sync tokens must never fall back to page-readable localStorage.
        if (key === TOKEN_KEY) {
            try {
                if (typeof GM_setValue !== 'function') {
                    try { localStorage.removeItem(TOKEN_KEY); } catch {}
                    return false;
                }
                GM_setValue(key, value);
                try { localStorage.removeItem(key); } catch {}
                return true;
            } catch {
                try { localStorage.removeItem(TOKEN_KEY); } catch {}
                return false;
            }
        }

        // Keep ordinary script state in Tampermonkey storage when available.
        try {
            if (typeof GM_setValue === 'function') {
                GM_setValue(key, value);
                try { localStorage.removeItem(key); } catch {}
                return true;
            }
        } catch {}
        try {
            localStorage.setItem(key, String(value));
            return true;
        } catch {
            return false;
        }
    }

    function removeStoredValue(key) {
        try { GM_setValue(key, ''); } catch {}
        try { localStorage.removeItem(key); } catch {}
    }

    function getToken() {
        let token = '';
        try {
            token = String(GM_getValue(TOKEN_KEY, '') || '').trim();
            if (token) return token;
        } catch {}

        // Migrate older versions' localStorage token into isolated userscript storage.
        try { token = String(localStorage.getItem(TOKEN_KEY) || '').trim(); } catch {}
        if (!token) return '';

        try {
            if (typeof GM_setValue !== 'function') {
                try { localStorage.removeItem(TOKEN_KEY); } catch {}
                return '';
            }
            GM_setValue(TOKEN_KEY, token);
            try { localStorage.removeItem(TOKEN_KEY); } catch {}
            return token;
        } catch {
            try { localStorage.removeItem(TOKEN_KEY); } catch {}
            return '';
        }
    }

    function getCustomPrefix(role) {
        const key = role === 'Gump'
            ? GUMP_CUSTOM_PREFIX_KEY
            : role === 'Recruit'
                ? RECRUIT_CUSTOM_PREFIX_KEY
                : '';
        return key ? trimNickname(readStoredValue(key, '') || '') : '';
    }

    function getEffectivePrefix(role, customPrefix = getCustomPrefix(role)) {
        return trimNickname(customPrefix || role);
    }

    function readManagedPrefixes() {
        try {
            const raw = readStoredValue(MANAGED_PREFIXES_KEY, '[]');
            const parsed = JSON.parse(raw || '[]');
            return Array.isArray(parsed) ? parsed.map(value => trimNickname(value)).filter(Boolean) : [];
        } catch {
            return [];
        }
    }

    function rememberManagedPrefix(prefix) {
        const value = trimNickname(prefix);
        if (!value) return;
        const prefixes = readManagedPrefixes();
        if (!prefixes.some(item => item.toLowerCase() === value.toLowerCase())) {
            prefixes.push(value);
            writeStoredValue(MANAGED_PREFIXES_KEY, JSON.stringify(prefixes.slice(-50)));
        }
    }

    function getAllManagedPrefixes() {
        return [...new Set([
            'Gump', 'Recruit',
            getEffectivePrefix('Gump'),
            getEffectivePrefix('Recruit'),
            ...readManagedPrefixes()
        ].map(value => trimNickname(value)).filter(Boolean))];
    }

    function migrateLegacyPrefix() {
        const gumpCurrent = getCustomPrefix('Gump');
        const recruitCurrent = getCustomPrefix('Recruit');
        rememberManagedPrefix(gumpCurrent);
        rememberManagedPrefix(recruitCurrent);

        const legacy = trimNickname(readStoredValue(LEGACY_CUSTOM_PREFIX_KEY, '') || '');
        if (!legacy) return;

        if (gumpCurrent || recruitCurrent) {
            rememberManagedPrefix(legacy);
            removeStoredValue(LEGACY_CUSTOM_PREFIX_KEY);
            return;
        }

        // A legacy shared prefix cannot be copied to both roles because role
        // prefixes must remain distinct. Preserve it on one role only.
        if (legacy.toLowerCase() === 'recruit') {
            writeStoredValue(RECRUIT_CUSTOM_PREFIX_KEY, legacy);
        } else {
            writeStoredValue(GUMP_CUSTOM_PREFIX_KEY, legacy);
        }
        rememberManagedPrefix(legacy);
        removeStoredValue(LEGACY_CUSTOM_PREFIX_KEY);
    }

    function applyCustomPrefix(nickname, role) {
        const base = trimNickname(nickname);
        const prefix = getCustomPrefix(role);
        if (!prefix) return base;

        // Replace the built-in role prefix when one is present.
        const withoutBuiltInPrefix = base.replace(/^(?:Gump|Recruit)\s+/i, '');
        return trimNickname(`${prefix} ${withoutBuiltInPrefix}`);
    }

    function trimNickname(value) {
        const normalized = String(value || '')
            .replace(/[\r\n]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        // Enforce Steam's 32 UTF-16-unit limit without ever splitting a surrogate pair.
        let result = '';
        for (const character of normalized) {
            if (result.length + character.length > MAX_NICKNAME_LENGTH) break;
            result += character;
        }
        return result;
    }

    function getSteamId() {
        const profileMatch = location.pathname.match(/^\/profiles\/(\d{17})\/friends\/?$/);
        if (profileMatch) return profileMatch[1];

        if (/^\d{17}$/.test(String(window.g_steamID || ''))) {
            return String(window.g_steamID);
        }

        const html = document.documentElement.innerHTML;
        const patterns = [
            /g_steamID\s*=\s*["'](\d{17})["']/,
            /g_steamID\s*=\s*"?(\d{17})"?/,
            /\bsteamid\b[^\d]{0,40}(\d{17})/i
        ];
        for (const pattern of patterns) {
            const match = html.match(pattern);
            if (match?.[1]) return match[1];
        }

        return '';
    }

    function getSessionId() {
        if (window.g_sessionID) return String(window.g_sessionID);

        const input = document.querySelector('input[name="sessionid"]');
        if (input?.value) return input.value;

        const html = document.documentElement.innerHTML;
        const patterns = [
            /g_sessionID\s*=\s*["']([^"']+)["']/,
            /g_sessionID\s*=\s*decodeURIComponent\(["']([^"']+)["']\)/,
            /"sessionid"\s*:\s*"([^"]+)"/
        ];
        for (const pattern of patterns) {
            const match = html.match(pattern);
            if (match?.[1]) return match[1];
        }
        return '';
    }

    function isFriendsPage() {
        const path = location.pathname;
        return path === '/my/friends'
            || path === '/my/friends/'
            || /^\/profiles\/\d{17}\/friends\/?$/.test(path);
    }

    function setStatus(message, progress = '') {
        const status = document.querySelector('#discord-steam-sync-status');
        const progressEl = document.querySelector('#discord-steam-sync-progress');
        if (status) status.textContent = message;
        if (progressEl) progressEl.textContent = progress;
    }

    function setButtonDisabled(disabled) {
        document.querySelectorAll('#discord-steam-sync-panel button').forEach(button => {
            if (button.id === 'discord-steam-sync-close') return;
            if (button.id === 'discord-steam-sync-stop') {
                button.disabled = false;
                return;
            }
            button.disabled = disabled;
        });
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function apiRequest(method, url, body = null) {
        const token = getToken();
        const endpoint = String(url).split('?')[0];
        console.log('[Discord Steam Sync] Relay request starting.', {
            method,
            endpoint,
            hasSyncToken: Boolean(token),
            tokenLength: token.length
        });
        if (!token) {
            console.warn('[Discord Steam Sync] Relay request not started: no sync token is configured.');
            return Promise.reject(new Error('No sync token is configured.'));
        }

        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (fn, value) => {
                if (settled) return;
                settled = true;
                fn(value);
            };

            const timer = setTimeout(() => finish(reject, new Error('Request timed out.')), REQUEST_TIMEOUT_MS);

            GM_xmlhttpRequest({
                method,
                url,
                headers: {
                    Accept: 'application/json',
                    Authorization: `Bearer ${token}`,
                    ...(body ? { 'Content-Type': 'application/json' } : {})
                },
                data: body ? JSON.stringify(body) : undefined,
                onload: response => {
                    clearTimeout(timer);
                    const rawBody = String(response.responseText || '');
                    const responseBody = rawBody
                        .replace(/<[^>]*>/g, ' ')
                        .replace(/\\s+/g, ' ')
                        .trim()
                        .slice(0, 800) || '(empty response body)';
                    const endpoint = String(url).split('?')[0];

                    console.log('[Discord Steam Sync] Relay response received.', {
                        method,
                        endpoint,
                        status: response.status,
                        statusText: String(response.statusText || ''),
                        responseBody
                    });

                    // Check HTTP status before parsing: gateways often return HTML/plain-text
                    // error pages for 401/5xx responses rather than JSON.
                    if (response.status < 200 || response.status >= 300) {
                        let errorData = {};
                        try { errorData = JSON.parse(rawBody || '{}'); } catch { /* non-JSON error body */ }

                        // Never log request headers or the bearer sync token.
                        console.error('[Discord Steam Sync] Relay API request failed.', {
                            method,
                            endpoint,
                            status: response.status,
                            statusText: String(response.statusText || ''),
                            responseBody
                        });
                        const message = response.status === 401
                            ? 'The Discord/Railway sync API rejected your sync token (HTTP 401). ' +
                              'The token has been kept so you do not have to re-enter it yet. ' +
                              'Relay response: ' + responseBody
                            : (errorData.error || `HTTP ${response.status}: ${responseBody}`);
                        finish(reject, new Error(message));
                        return;
                    }

                    let data = {};
                    try { data = JSON.parse(rawBody || '{}'); }
                    catch {
                        console.error('[Discord Steam Sync] Relay API returned invalid JSON.', {
                            method, endpoint, status: response.status, responseBody
                        });
                        finish(reject, new Error('The Discord/Railway sync API returned invalid JSON: ' + responseBody));
                        return;
                    }
                    console.log('[Discord Steam Sync] Relay JSON parsed successfully.', {
                        endpoint,
                        ok: data?.ok,
                        complete: data?.complete,
                        states: Array.isArray(data?.states) ? data.states.length : undefined,
                        steamIdPresent: Boolean(data?.steamId)
                    });
                    finish(resolve, data);
                },
                onerror: () => {
                    clearTimeout(timer);
                    finish(reject, new Error('Network request failed.'));
                },
                ontimeout: () => {
                    clearTimeout(timer);
                    finish(reject, new Error('Request timed out.'));
                }
            });
        });
    }

    function getStateSteamId(state) {
        // The relay always supplies steamId. Do not fall back to a generic `id`,
        // which could be a Discord snowflake and accidentally target the wrong account.
        const candidates = [state?.steamId, state?.steamID, state?.steam_id];
        for (const value of candidates) {
            const id = String(value || '').trim();
            if (/^\d{17}$/.test(id)) return id;
        }
        return '';
    }

    function getStateNickname(state) {
        return trimNickname(
            state?.nickname ??
            state?.discordUsername ??
            state?.discord_username ??
            state?.username ??
            ''
        );
    }

    function getSteamDisplayName(block) {
        if (!block) return '';
        // Official Steam Web API friend records are normalized to this shape.
        const apiPersonaName = trimNickname(block.personaName || block.personaname || '');
        if (apiPersonaName) return apiPersonaName;

        // Prefer Steam's visible persona/display-name element. This avoids
        // accidentally treating a local nickname as the persona name if Steam
        // changes the data-search contents.
        const selectors = [
            '.persona_name',
            '.friendname',
            '.friendName',
            '.friend_block_content .friendname',
            '.friend_block_content .friendName',
            '.friend_block_content a[href*="/profiles/"]',
            'a[href*="/profiles/"]'
        ];

        for (const selector of selectors) {
            const element = block.querySelector?.(selector);
            const name = trimNickname(element?.textContent || '');
            if (name) return name;
        }

        if (block.matches?.('a[href*="/profiles/"]')) {
            const name = trimNickname(block.textContent || '');
            if (name) return name;
        }

        // Steam friend entries have historically exposed the persona name in
        // data-search as the first value before " ;". Keep this as a final
        // fallback for layouts where the visible name element is unavailable.
        const dataSearch = String(block.getAttribute?.('data-search') || '');
        if (dataSearch) {
            const searchName = trimNickname(dataSearch.split(/\s*;\s*/)[0] || '');
            if (searchName) return searchName;
        }

        return '';
    }

    function buildSteamNickname(state, block) {
        const steamName = getSteamDisplayName(block);
        if (!steamName) {
            throw new Error('Could not read a Steam display name for one of the matching friends.');
        }

        const discordNickname = getStateNickname(state);
        const roleMatch = discordNickname.match(/^(Gump|Recruit)\s+/i);
        const rolePrefix = String(state?.role || (roleMatch ? roleMatch[1] : '')).trim();
        if (rolePrefix !== 'Gump' && rolePrefix !== 'Recruit') {
            throw new Error('Discord role information is missing for a linked roster member.');
        }

        return applyCustomPrefix(rolePrefix + ' ' + steamName, rolePrefix);
    }

    async function steamApiRequest(url, label) {
        console.log('[Discord Steam Sync] Steam API request starting.', {
            label,
            endpoint: String(url).split('?')[0],
            hasApiKey: Boolean(getSteamApiKey())
        });

        const response = await new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                timeout: REQUEST_TIMEOUT_MS,
                headers: { Accept: 'application/json' },
                onload: resolve,
                onerror: () => reject(new Error(`Could not contact Steam to retrieve ${label}.`)),
                ontimeout: () => reject(new Error(`Steam timed out while retrieving ${label}.`))
            });
        });

        console.log('[Discord Steam Sync] Steam API response received.', {
            label,
            endpoint: String(url).split('?')[0],
            status: response.status,
            statusText: String(response.statusText || '')
        });

        if (response.status === 401) {
            const responseBody = String(response.responseText || '')
                .replace(/<[^>]*>/g, ' ')
                .replace(/\\s+/g, ' ')
                .trim()
                .slice(0, 800) || '(empty response body)';
            const endpoint = String(url).split('?')[0].split('/').slice(-3).join('/');
            let requestedSteamId = '';
            try {
                requestedSteamId = new URL(url).searchParams.get('steamid') || '';
            } catch {
                requestedSteamId = '';
            }

            // Never log the full request URL: it contains the user's Steam Web API key.
            console.error('[Discord Steam Sync] Steam API returned HTTP 401.', {
                label,
                endpoint,
                steamId: requestedSteamId || '(not present in request)',
                statusText: String(response.statusText || ''),
                responseBody
            });

            const privacyHint = label.includes('friends list')
                ? ' Your Friends List is already public, so we should not assume privacy is the cause.'
                : '';
            throw new Error(
                'Steam returned HTTP 401 while retrieving ' + label + '.' + privacyHint +
                ' Steam response: ' + responseBody +
                ' Check the browser Console for the diagnostic details. No nickname changes were made.'
            );
        }
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`Steam returned HTTP ${response.status} while retrieving ${label}. No nickname changes were made.`);
        }

        let payload;
        try {
            payload = JSON.parse(String(response.responseText || '{}'));
        } catch {
            throw new Error(`Steam returned invalid data while retrieving ${label}. No nickname changes were made.`);
        }
        console.log('[Discord Steam Sync] Steam API JSON parsed successfully.', { label });
        return payload;
    }

    async function scanFriends() {
        const apiKey = getSteamApiKey();
        const steamId = getSteamId();
        console.log('[Discord Steam Sync] scanFriends starting.', {
            hasApiKey: Boolean(apiKey),
            apiKeyLength: apiKey.length,
            steamIdPresent: Boolean(steamId),
            steamId
        });
        if (!apiKey) throw new Error('Set your Steam Web API key before syncing so the script can retrieve your complete Steam friends list.');
        if (!steamId) throw new Error('Could not identify the Steam account for the friends-list request.');

        setStatus('Retrieving your complete Steam friends list from Steam…');
        const friendPayload = await steamApiRequest(
            `https://api.steampowered.com/ISteamUser/GetFriendList/v1/?key=${encodeURIComponent(apiKey)}&steamid=${encodeURIComponent(steamId)}&relationship=friend`,
            'your complete Steam friends list'
        );
        const friendRows = friendPayload?.friendslist?.friends;
        console.log('[Discord Steam Sync] Steam friends-list payload received.', {
            hasFriendsList: Boolean(friendPayload?.friendslist),
            friendCount: Array.isArray(friendRows) ? friendRows.length : null
        });
        if (!Array.isArray(friendRows)) {
            throw new Error('Steam did not return a complete, readable friends list. Check your Steam privacy settings and API key. No nickname changes were made.');
        }

        const ids = [...new Set(friendRows.map(row => String(row?.steamid || '').trim()).filter(id => /^\d{17}$/.test(id)))];
        if (ids.length !== friendRows.length) {
            throw new Error('Steam returned a friends list containing missing or invalid SteamIDs. No nickname changes were made.');
        }

        const friends = new Map();
        const batchSize = 100;
        for (let offset = 0; offset < ids.length; offset += batchSize) {
            if (stopRequested) throw new Error('Sync stopped.');
            const batch = ids.slice(offset, offset + batchSize);
            setStatus('Retrieving Steam friend names…', `Loading ${Math.min(offset + batch.length, ids.length)} / ${ids.length}`);
            const summaryPayload = await steamApiRequest(
                `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(apiKey)}&steamids=${batch.join(',')}`,
                'Steam friend profile names'
            );
            const players = summaryPayload?.response?.players;
            if (!Array.isArray(players)) {
                throw new Error('Steam did not return readable profile names for the complete friends list. No nickname changes were made.');
            }
            const requestedIds = new Set(batch);
            const receivedIds = new Set();
            for (const player of players) {
                const id = String(player?.steamid || '').trim();
                const personaName = trimNickname(player?.personaname || '');
                if (!requestedIds.has(id) || receivedIds.has(id) || !personaName) {
                    throw new Error('Steam returned an unexpected, duplicate, or incomplete profile record. No nickname changes were made.');
                }
                receivedIds.add(id);
                friends.set(id, { personaName });
            }
            const missingBatchIds = batch.filter(id => !receivedIds.has(id));
            if (missingBatchIds.length) {
                throw new Error('Steam did not return every requested friend profile. No nickname changes were made. Missing SteamIDs: ' + missingBatchIds.slice(0, 10).join(', ') + (missingBatchIds.length > 10 ? ', …' : ''));
            }
            await sleep(150);
        }

        const missingNames = ids.filter(id => !friends.has(id));
        if (missingNames.length) {
            throw new Error(
                `Steam returned ${ids.length} friends, but profile names could only be verified for ${friends.size}. ` +
                `The list is not considered complete. No nickname changes were made. Missing SteamIDs: ${missingNames.slice(0, 10).join(', ')}${missingNames.length > 10 ? ', …' : ''}`
            );
        }

        lastFriendCoverageCheckAt = Date.now();
        setStatus('Complete Steam friends list retrieved.', `${friends.size} friends verified through Steam Web API`);
        return friends;
    }

    function readFriendRequestState() {
        try {
            const raw = readStoredValue(FRIEND_REQUESTS_KEY, '{}');
            const parsed = JSON.parse(raw || '{}');
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            return {};
        }
    }

    function writeFriendRequestState(state) {
        writeStoredValue(FRIEND_REQUESTS_KEY, JSON.stringify(state));
    }

    async function sendSteamFriendRequest(steamId) {
        const sessionID = getSessionId();
        if (!sessionID) throw new Error('Steam session ID was not found.');

        const state = readFriendRequestState();
        const last = Number(state[steamId] || 0);
        if (Date.now() - last < FRIEND_REQUEST_COOLDOWN_MS) return 'throttled';

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://steamcommunity.com/actions/AddFriendAjax',
                timeout: REQUEST_TIMEOUT_MS,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                data: `sessionID=${encodeURIComponent(sessionID)}&steamid=${encodeURIComponent(steamId)}&accept_invite=0`,
                onload: response => {
                    const text = String(response.responseText || '').toLowerCase();
                    if (response.status >= 200 && response.status < 300) {
                        let parsed = null;
                        try {
                            parsed = JSON.parse(String(response.responseText || ''));
                        } catch {}

                        // Steam's endpoint normally returns JSON. Treat explicit
                        // non-success codes as failures instead of assuming that
                        // any HTTP 200 means the request was accepted.
                        const alreadyPending =
                            /already\s+friends|already\s+sent|pending|duplicate|request\s+(?:already\s+)?sent/.test(text);

                        if (parsed && (parsed.success === true || Number(parsed.success) === 1)) {
                            state[steamId] = Date.now();
                            writeFriendRequestState(state);
                            return resolve('sent');
                        }

                        if (alreadyPending) {
                            state[steamId] = Date.now();
                            writeFriendRequestState(state);
                            return resolve('pending');
                        }

                        if (
                            !parsed ||
                            (Object.prototype.hasOwnProperty.call(parsed, 'success')) ||
                            (parsed.error && String(parsed.error).trim())
                        ) {
                            reject(new Error(`Steam friend request was rejected for ${steamId}.`));
                            return;
                        }

                        reject(new Error(`Steam returned an unrecognized friend-request response for ${steamId}.`));
                        return;
                    }

                    if (/already\s+friends|already\s+sent|pending|duplicate/.test(text)) {
                        state[steamId] = Date.now();
                        writeFriendRequestState(state);
                        return resolve('pending');
                    }

                    reject(new Error(`Steam friend request failed for ${steamId}.`));
                },
                onerror: () => reject(new Error(`Steam friend request failed for ${steamId}.`)),
                ontimeout: () => reject(new Error(`Steam friend request timed out for ${steamId}.`))
            });
        });
    }

    function getSteamApiKey() {
        // Keep the Steam Web API key in Tampermonkey's private script storage;
        // do not mirror it into page-accessible localStorage.
        try { return String(GM_getValue(STEAM_API_KEY_STORAGE, '') || '').trim(); }
        catch { return ''; }
    }

    function setupSteamApiKey() {
        const current = getSteamApiKey();
        const instructions =
            'STEAM WEB API KEY SETUP\\n\\n' +
            'WHY THIS IS NEEDED\\n' +
            'The key lets the script retrieve your complete Steam friends list and profile names so it can sync local nicknames for linked Gump and Recruit members.\\n\\n' +
            'HOW TO GET YOUR KEY\\n' +
            '1. Open https://steamcommunity.com/dev/apikey.\\n' +
            '2. Sign in to the same Steam account you use with this script.\\n' +
            '3. Copy the 32-character Web API Key shown by Steam.\\n' +
            '4. Return here and paste the key below.\\n\\n' +
            'PRIVACY\\n' +
            '• The key is saved only in this browser’s Tampermonkey storage.\\n' +
            '• It is sent directly to Steam’s official Web API for friends and profile information.\\n' +
            '• It is NOT sent to our Discord bot, Railway, or GitHub.\\n' +
            '• We do not ask for your Steam password, session cookie, or Discord credentials.\\n\\n' +
            'Nickname changes are submitted through your signed-in Steam Community session. Independent nickname verification is temporarily disabled.\\n\\n' +
            'Paste your Steam Web API key below:';
        const key = prompt(instructions, current);
        if (key === null) return;
        const value = key.trim();
        if (!value) {
            setStatus('No API key entered. Your existing key was not changed.');
            return;
        }
        if (!STEAM_API_KEY_PATTERN.test(value)) {
            setStatus('Invalid Steam Web API key. It should be 32 hexadecimal characters. Your saved key was not changed.');
            alert('That does not look like a valid Steam Web API key. Your saved key was not changed.');
            return;
        }
        try { GM_setValue(STEAM_API_KEY_STORAGE, value); }
        catch {
            setStatus('Could not save the Steam Web API key in Tampermonkey storage.');
            return;
        }
        setStatus('Steam Web API key saved locally. You are ready to sync nicknames.');
    }

    function removeSteamApiKey() {
        if (!getSteamApiKey()) {
            setStatus('No Steam API key is currently saved.');
            return;
        }
        if (!confirm('Remove the Steam Web API key saved in this Tampermonkey installation? Nickname syncing will be unavailable until you add a key again.')) return;
        try {
            GM_deleteValue(STEAM_API_KEY_STORAGE);
            setStatus('Steam Web API key removed from this Tampermonkey installation.');
        } catch {
            setStatus('Could not remove the Steam Web API key from Tampermonkey storage.');
        }
    }

    function readManagedNicknames() {
        try {
            const raw = readStoredValue(MANAGED_NICKNAMES_KEY, '{}');
            const parsed = JSON.parse(raw || '{}');
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch {
            return {};
        }
    }

    function hasManagedRolePrefix(nickname) {
        const value = trimNickname(nickname).toLowerCase();
        return getAllManagedPrefixes().some(prefix => {
            const normalized = prefix.toLowerCase();
            return normalized && value.startsWith(normalized + ' ');
        });
    }

    async function postSteamNickname(steamId, nickname) {
        const sessionID = getSessionId();
        if (!sessionID) throw new Error('Steam session ID was not found.');
        const expectedNickname = trimNickname(nickname);
        await new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: `https://steamcommunity.com/profiles/${steamId}/ajaxsetnickname/`,
                timeout: REQUEST_TIMEOUT_MS,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                data: `nickname=${encodeURIComponent(expectedNickname)}&sessionid=${encodeURIComponent(sessionID)}`,
                onload: response => {
                    if (response.status < 200 || response.status >= 300) return reject(new Error(`Steam nickname update failed for ${steamId} (HTTP ${response.status}).`));
                    let data;
                    try { data = JSON.parse(String(response.responseText || '{}')); }
                    catch { return reject(new Error(`Steam nickname update returned invalid data for ${steamId}.`)); }
                    if (Number(data?.success) !== 1) return reject(new Error(`Steam nickname update failed for ${steamId}.`));
                    resolve();
                },
                onerror: () => reject(new Error(`Steam nickname update failed for ${steamId}.`)),
                ontimeout: () => reject(new Error(`Steam nickname update timed out for ${steamId}.`))
            });
        });
    }

    async function applyNicknameBatch(changes, progressLabel) {
        const seenIds = new Set();
        for (const change of changes) {
            if (!/^\d{17}$/.test(String(change?.steamId || '')) || seenIds.has(change.steamId)) {
                throw new Error('Nickname batch contains an invalid or duplicate SteamID. No nickname changes were submitted.');
            }
            seenIds.add(change.steamId);
            change.nickname = trimNickname(change.nickname);
        }

        const accepted = [];
        const failed = [];
        let processed = 0;
        for (const change of changes) {
            if (stopRequested) throw new Error('Sync stopped.');
            setStatus(progressLabel, `Submitting ${++processed} / ${changes.length}`);
            try {
                await postSteamNickname(change.steamId, change.nickname);
                accepted.push(change);
            } catch (error) {
                failed.push({
                    steamId: change.steamId,
                    message: error?.message || 'Steam did not accept the nickname update.'
                });
                console.warn('[Discord Steam Sync] Steam nickname update failed:', change.steamId, error?.message || error);
            }
            await sleep(350);
        }
        return { accepted, failed };
    }

    function friendCoverageSignature(states, friends) {
        return states
            .map(item => getStateSteamId(item))
            .filter(Boolean)
            .sort()
            .map(steamId => `${steamId}:${friends.has(steamId) ? 'friend' : 'missing'}`)
            .join('|');
    }

    function stateSignature(states) {
        const normalized = states
            .map(item => ({
                steamId: getStateSteamId(item),
                nickname: getStateNickname(item),
                role: String(item?.role || '').trim()
            }))
            .filter(item => item.steamId && item.nickname)
            .sort((a, b) => a.steamId.localeCompare(b.steamId));
        return JSON.stringify(normalized.map(item => [item.steamId, item.role, item.nickname]));
    }

    async function syncNicknames(force = false) {
        console.log('[Discord Steam Sync] syncNicknames entered.', {
            force,
            syncRunning,
            friendsPage: isFriendsPage(),
            hasSyncToken: Boolean(getToken()),
            hasSteamApiKey: Boolean(getSteamApiKey()),
            steamId: getSteamId()
        });
        if (syncRunning) {
            console.warn('[Discord Steam Sync] Sync skipped because another sync is already running.');
            return;
        }
        if (!getToken()) { setStatus('No sync token configured.'); return; }
        if (!isFriendsPage()) { setStatus('Open Steam → Friends to run nickname sync.'); return; }
        if (!getSteamApiKey()) { setStatus('Select “Set Steam API Key” and add your Steam Web API key before syncing.'); return; }
        if (force) removeStoredValue(AUTO_SYNC_PAUSED_AFTER_CLEAR_KEY);

        syncRunning = true;
        stopRequested = false;
        setButtonDisabled(true);
        let acceptedPrefixes = 0, acceptedRemovals = 0, failed = 0;
        let notFriends = 0, requestsSent = 0, requestPending = 0, requestCooldown = 0, requestFailed = 0;
        try {
            setStatus('Loading Discord sync data…');
            const data = await apiRequest('GET', SYNC_API_URL + '/client/all-state');
            if (!getSteamApiKey()) throw new Error('Steam Web API key is missing.');
            const currentSteamId = getSteamId();
            if (!currentSteamId || data.steamId !== currentSteamId) throw new Error('This sync token is not for the Steam account currently signed in.');
            if (data.ok !== true || data.complete !== true || !Array.isArray(data.states)) throw new Error('Sync data is incomplete. No nicknames were changed.');

            const memberCount = Number(data.memberCount), fetchedMemberCount = Number(data.fetchedMemberCount);
            if (!Number.isFinite(memberCount) || !Number.isFinite(fetchedMemberCount) || memberCount < 0 || fetchedMemberCount < memberCount) {
                throw new Error('Discord member data is incomplete or its coverage counts are invalid. No nicknames were changed.');
            }

            const signature = stateSignature(data.states);
            const previous = String(readStoredValue(LAST_COMPLETED_SIGNATURE_KEY, '') || '');
            const needsCheck = force || signature !== previous.split('\n#coverage:')[0] || Date.now() - lastFriendCoverageCheckAt >= FRIEND_COVERAGE_RECHECK_MS;
            if (!needsCheck) { setStatus('Already synchronized.'); return; }

            setStatus('Retrieving your complete Steam friends list…');
            const friends = await scanFriends();
            lastFriendCoverageCheckAt = Date.now();

            const coverage = friendCoverageSignature(data.states, friends);
            const stateById = new Map();
            for (const state of data.states) {
                const id = getStateSteamId(state);
                if (id && getStateNickname(state)) stateById.set(id, state);
            }

            const desired = new Map();
            for (const [id, state] of stateById) {
                if (id === currentSteamId) continue;
                const role = String(state.role || '').trim();
                if (role === 'Gump' || role === 'Recruit') desired.set(id, state);
            }

            // Track only nicknames this browser has successfully submitted. This lets
            // later syncs remove a managed prefix when a member loses their role.
            const managed = readManagedNicknames();
            const changes = [];
            for (const [steamId, state] of desired) {
                if (!friends.has(steamId)) continue;
                const nickname = buildSteamNickname(state, friends.get(steamId));
                if (String(managed[steamId] || '') !== nickname) {
                    changes.push({ steamId, nickname, type: 'prefix' });
                }
            }
            for (const steamId of Object.keys(managed)) {
                if (desired.has(steamId) || steamId === currentSteamId) continue;
                if (!friends.has(steamId)) continue;
                const personaName = getSteamDisplayName(friends.get(steamId));
                if (!personaName) continue;
                changes.push({ steamId, nickname: personaName, type: 'removal' });
            }
            changes.sort((a, b) => a.steamId.localeCompare(b.steamId));

            const expected = JSON.stringify(changes.map(change => [change.steamId, change.type, change.nickname]));
            const completionSignature = signature + '\n#coverage:' + coverage + '\\n#changes:' + expected;
            if (!force && completionSignature === previous && changes.length === 0) {
                setStatus('Already synchronized.');
                return;
            }

            notFriends = [...desired.keys()].filter(id => !friends.has(id)).length;
            for (const [id] of desired) {
                if (friends.has(id)) continue;
                if (stopRequested) throw new Error('Sync stopped.');
                try {
                    const result = await sendSteamFriendRequest(id);
                    if (result === 'sent') requestsSent++;
                    else if (result === 'pending') requestPending++;
                    else if (result === 'throttled') requestCooldown++;
                } catch (error) {
                    requestFailed++;
                    console.warn('[Discord Steam Sync] Friend request failed:', id, error?.message || error);
                }
                await sleep(350);
            }

            console.log('[Discord Steam Sync] Submitting nickname changes without independent read-back verification.', {
                changeCount: changes.length
            });
            const result = await applyNicknameBatch(changes, 'Updating Steam local nicknames…');
            for (const item of result.accepted) {
                if (item.type === 'removal') {
                    delete managed[item.steamId];
                    acceptedRemovals++;
                } else {
                    managed[item.steamId] = item.nickname;
                    acceptedPrefixes++;
                }
            }
            writeStoredValue(MANAGED_NICKNAMES_KEY, JSON.stringify(managed));
            failed = result.failed.length;
            if (failed === 0 && notFriends === 0 && requestFailed === 0) {
                writeStoredValue(LAST_COMPLETED_SIGNATURE_KEY, signature + '\n#coverage:' + coverage);
            } else {
                removeStoredValue(LAST_COMPLETED_SIGNATURE_KEY);
            }

            const needsAttention = failed > 0 || notFriends > 0 || requestFailed > 0;
            setStatus(
                needsAttention ? 'Sync finished with items needing attention.' : 'Nickname updates submitted successfully.',
                acceptedPrefixes + ' prefixes accepted by Steam; ' + acceptedRemovals +
                ' old prefixes removed; ' + failed + ' update failures; ' + notFriends +
                ' linked members are not Steam friends; ' + requestsSent + ' friend requests sent; ' +
                requestPending + ' already pending; ' + requestCooldown + ' on 24-hour cooldown; ' +
                requestFailed + ' request failures. Nickname changes are not independently verified.'
            );
        } catch (error) {
            console.error('[Discord Steam Sync] syncNicknames failed.', error);
            setStatus(error.message || 'Sync failed. No nickname changes were confirmed.');
        } finally {
            syncRunning = false;
            setButtonDisabled(false);
            console.log('[Discord Steam Sync] syncNicknames finished.', { syncRunning });
        }
    }

    function setupCustomPrefix(role) {
        const otherRole = role === 'Gump' ? 'Recruit' : 'Gump';
        const key = role === 'Gump' ? GUMP_CUSTOM_PREFIX_KEY : RECRUIT_CUSTOM_PREFIX_KEY;
        const current = getCustomPrefix(role);
        const value = prompt(
            'Enter your custom Steam nickname prefix for ' + role + ' members.\n\n' +
            'Leave blank to use the default "' + role + '" prefix.',
            current
        );
        if (value === null) return;

        const prefix = trimNickname(value);
        if (prefix.length > 24) {
            const warning = 'Custom prefixes must be 24 characters or fewer so the Steam display name remains visible.';
            setStatus(warning);
            alert(warning);
            return;
        }
        const otherPrefix = getEffectivePrefix(otherRole);
        const proposedPrefix = getEffectivePrefix(role, prefix);

        if (proposedPrefix.toLowerCase() === otherPrefix.toLowerCase()) {
            const warning = 'Gump and Recruit prefixes must be different. Please choose two unique prefixes.';
            setStatus(warning);
            alert(warning);
            return;
        }

        rememberManagedPrefix(current || role);
        rememberManagedPrefix(proposedPrefix);
        writeStoredValue(key, prefix);

        if (prefix) {
            setStatus(role + ' custom prefix saved: ' + prefix, 'Syncing nicknames with the updated role prefix…');
        } else {
            setStatus(role + ' custom prefix cleared.', 'Restoring the default "' + role + '" prefix…');
        }

        syncNicknames(true).catch(error => setStatus(error.message || role + ' prefix sync failed.'));
    }

    function setupToken() {
        const current = getToken();
        const promptMessage = current
            ? 'Paste the personal token generated by /sync-setup in Discord.'
            : 'No sync token is configured yet.\n\nGo to Discord and run /sync-setup to generate your personal token, then paste it here.';
        const token = prompt(promptMessage, current);
        if (token === null) return;
        const value = token.trim();
        if (!/^[a-f0-9]{64}$/i.test(value)) {
            setStatus('Invalid token. Tokens are exactly 64 hexadecimal characters.');
            return;
        }
        if (!writeStoredValue(TOKEN_KEY, value)) {
            setStatus('Could not securely save the sync token in Tampermonkey storage. The token was not saved to page-accessible storage.');
            alert('Could not securely save the sync token. Please check Tampermonkey storage permissions and try again.');
            return;
        }
        setStatus('Token saved securely. Testing sync…');
        syncNicknames(true).catch(error => setStatus(error.message || 'Token test failed.'));
    }

    let uiObserver = null;
    let uiRetryTimer = null;
    let uiStyleInjected = false;
    let uiDismissed = false;

    const UI_CSS = `
        #discord-steam-sync-panel{position:fixed!important;right:18px!important;bottom:18px!important;z-index:2147483647!important;width:310px!important;background:#171d25!important;color:#d6d7d8!important;border:1px solid #3b4450!important;border-radius:6px!important;box-shadow:0 8px 30px rgba(0,0,0,.55)!important;font:14px Arial,sans-serif!important;display:block!important;visibility:visible!important;opacity:1!important;pointer-events:auto!important}
        #discord-steam-sync-header{display:flex!important;align-items:center!important;justify-content:space-between!important;padding:10px 12px!important;background:#1b2838!important;border-bottom:1px solid #3b4450!important;font-weight:700!important}
        #discord-steam-sync-close{background:none!important;border:0!important;color:#aaa!important;font-size:18px!important;cursor:pointer!important;padding:0 4px!important}
        #discord-steam-sync-body{padding:12px!important}
        #discord-steam-sync-panel button:not(#discord-steam-sync-close){width:100%!important;margin:0 0 8px!important;padding:9px 10px!important;border:0!important;border-radius:3px!important;background:#2878c8!important;color:#ffffff!important;font-weight:700!important;cursor:pointer!important;box-sizing:border-box!important}
        #discord-steam-sync-panel button:not(#discord-steam-sync-close):hover{filter:brightness(1.08)!important}
        /* Primary action: green */
        #discord-steam-sync-panel button#discord-steam-sync-button{background-color:#58A864!important;color:#ffffff!important}
        /* Setup/configuration actions: blue */
        #discord-steam-sync-panel button#discord-steam-sync-setup,
        #discord-steam-sync-panel button#discord-steam-sync-api-key,
        #discord-steam-sync-panel button#discord-steam-sync-gump-prefix,
        #discord-steam-sync-panel button#discord-steam-sync-recruit-prefix{background-color:#2878c8!important;color:#ffffff!important}
        /* Destructive actions: red */
        #discord-steam-sync-panel button#discord-steam-sync-remove-api-key,
        #discord-steam-sync-panel button#discord-steam-sync-clear-friends{background-color:#c43d3d!important;color:#ffffff!important}
        /* Stop action: yellow */
        #discord-steam-sync-panel button#discord-steam-sync-stop{background-color:#e6b83f!important;color:#222222!important}
        #discord-steam-sync-panel button:disabled{opacity:.5!important;cursor:not-allowed!important}
        #discord-steam-sync-status{margin-top:4px!important;line-height:1.35!important;min-height:38px!important;color:#d7d7d7!important}
        #discord-steam-sync-progress{margin-top:5px!important;color:#8f98a0!important;font-size:12px!important}
        #discord-steam-sync-panel{width:380px!important;max-height:75vh!important;overflow-y:auto!important}
    `;

    function injectUIStyle() {
        if (uiStyleInjected) return;
        try {
            if (typeof GM_addStyle === 'function') GM_addStyle(UI_CSS);
            else throw new Error('GM_addStyle unavailable');
            uiStyleInjected = true;
        } catch {
            if (!document.getElementById('discord-steam-sync-style')) {
                const style = document.createElement('style');
                style.id = 'discord-steam-sync-style';
                style.textContent = UI_CSS;
                (document.head || document.documentElement).appendChild(style);
            }
            uiStyleInjected = true;
        }
    }

    function buildUI() {
        injectUIStyle();
        if (!document.body) return false;

        const existing = document.querySelector('#discord-steam-sync-panel');
        if (existing) return true;

        const panel = document.createElement('div');
        panel.id = 'discord-steam-sync-panel';
        panel.innerHTML = `
            <div id="discord-steam-sync-header">
                <span>Discord Steam Sync</span>
                <button id="discord-steam-sync-close" title="Close">×</button>
            </div>
            <div id="discord-steam-sync-body">
                <button id="discord-steam-sync-button">🔄 Sync All Nicknames</button>
                <button id="discord-steam-sync-setup">🔐 Set Sync Token</button>
                <button id="discord-steam-sync-api-key">🔑 Set Steam API Key</button>
                <button id="discord-steam-sync-remove-api-key">🗑️ Remove Steam API Key</button>
                <button id="discord-steam-sync-gump-prefix">🏷️ Set Gump Prefix</button>
                <button id="discord-steam-sync-recruit-prefix">🏷️ Set Recruit Prefix</button>
                <button id="discord-steam-sync-clear-friends">🧹 Remove All Friend Nicknames</button>
                <button id="discord-steam-sync-stop">🛑 Stop Current Sync</button>
                <div id="discord-steam-sync-status"></div>
                <div id="discord-steam-sync-progress"></div>
            </div>
        `;
        document.body.appendChild(panel);

        panel.querySelector('#discord-steam-sync-close').addEventListener('click', () => {
            uiDismissed = true;
            panel.remove();
        });
        panel.querySelector('#discord-steam-sync-button').addEventListener('click', () => syncNicknames(true));
        panel.querySelector('#discord-steam-sync-setup').addEventListener('click', setupToken);
        panel.querySelector('#discord-steam-sync-api-key').addEventListener('click', setupSteamApiKey);
        panel.querySelector('#discord-steam-sync-remove-api-key').addEventListener('click', removeSteamApiKey);
        panel.querySelector('#discord-steam-sync-gump-prefix').addEventListener('click', () => setupCustomPrefix('Gump'));
        panel.querySelector('#discord-steam-sync-recruit-prefix').addEventListener('click', () => setupCustomPrefix('Recruit'));
        panel.querySelector('#discord-steam-sync-clear-friends').addEventListener('click', clearAllFriendNicknames);
        panel.querySelector('#discord-steam-sync-stop').addEventListener('click', () => {
            stopRequested = true;
            setStatus('Stopping after the current request…');
        });


        const hasToken = Boolean(getToken());
        const hasApiKey = Boolean(getSteamApiKey());
        const autoSyncPaused = String(readStoredValue(AUTO_SYNC_PAUSED_AFTER_CLEAR_KEY, '') || '') === '1';
        setStatus(
            !hasToken ? 'Sync token required.' :
            !hasApiKey ? 'Steam API key required.' :
            autoSyncPaused ? 'Automatic sync paused after Remove All. Select Sync All Nicknames to resume.' :
            (isFriendsPage() ? 'Ready.' : 'Open Steam → Friends to sync.')
        );

        if (!hasToken) {
            setTimeout(() => {
                if (!getToken()) setupToken();
            }, 500);
        }

        return true;
    }

    function ensureUI() {
        if (uiDismissed || document.querySelector('#discord-steam-sync-panel')) return;
        if (buildUI()) return;

        clearTimeout(uiRetryTimer);
        uiRetryTimer = setTimeout(ensureUI, 250);
    }

    function startUIObserver() {
        ensureUI();

        if (uiObserver || !document.documentElement) return;
        uiObserver = new MutationObserver(() => {
            if (!uiDismissed && !document.querySelector('#discord-steam-sync-panel')) ensureUI();
        });
        uiObserver.observe(document.documentElement, { childList: true, subtree: true });
    }

    function startPolling() {
        clearInterval(pollTimer);
        pollTimer = setInterval(() => {
            if (document.hidden || !getToken() || !isFriendsPage() || syncRunning) return;
            if (String(readStoredValue(AUTO_SYNC_PAUSED_AFTER_CLEAR_KEY, '') || '') === '1') return;
            syncNicknames(false).catch(() => {});
        }, POLL_INTERVAL_MS);
    }

    function registerMenuCommands() {
        const commands = [
            ['Set Discord Steam Sync Token', setupToken],
            ['Set Steam Web API Key', setupSteamApiKey],
            ['Set Gump Nickname Prefix', () => setupCustomPrefix('Gump')],
            ['Set Recruit Nickname Prefix', () => setupCustomPrefix('Recruit')],
            ['Sync All Nicknames', () => syncNicknames(true)],
            ['Remove All Friend Nicknames', clearAllFriendNicknames]
        ];

        for (const [name, callback] of commands) {
            try {
                if (typeof GM_registerMenuCommand === 'function') {
                    GM_registerMenuCommand(name, callback);
                }
            } catch {}
        }
    }

    migrateLegacyPrefix();
    registerMenuCommands();
    startUIObserver();
    startPolling();

    setTimeout(() => {
        if (!getToken() || !isFriendsPage()) return;
        if (String(readStoredValue(AUTO_SYNC_PAUSED_AFTER_CLEAR_KEY, '') || '') === '1') {
            setStatus('Automatic sync is paused after Remove All. Select “Sync All Nicknames” to resume.');
            return;
        }
        syncNicknames(false).catch(() => {});
    }, 2500);
})();
