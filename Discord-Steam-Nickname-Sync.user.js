// ==UserScript==

// @name         Discord Steam Nickname Sync
// @namespace    discord-steam-sync
// @version      10.1.0
// @description  Sync Steam friend local nicknames from Discord roles.
// @homepageURL  https://github.com/RustyGumpers/Discord-steam-link
// @supportURL   https://github.com/RustyGumpers/Discord-steam-link/issues
// @updateURL    https://raw.githubusercontent.com/RustyGumpers/Discord-steam-link/main/Discord-Steam-Nickname-Sync.user.js
// @downloadURL  https://raw.githubusercontent.com/RustyGumpers/Discord-steam-link/main/Discord-Steam-Nickname-Sync.user.js
// @match        https://steamcommunity.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      steam-link-production.up.railway.app
// @connect      steamcommunity.com
// @run-at       document-idle
// ==/UserScript==

(() => {
    'use strict';

    const SYNC_API_URL = 'https://steam-link-production.up.railway.app';
    const TOKEN_KEY = 'discordSteamSyncToken';
    const CUSTOM_PREFIX_KEY = 'discordSteamSyncCustomPrefixV1';
    const LAST_COMPLETED_SIGNATURE_KEY = 'discordSteamSyncLastCompletedSignatureV10';
    const RESYNC_AFTER_CLEAR_KEY = 'discordSteamSyncResyncAfterClearV1';
    const FRIEND_REQUESTS_KEY = 'discordSteamSyncFriendRequestsV1';
    const FRIEND_REQUEST_COOLDOWN_MS = 24 * 60 * 60 * 1000;
    const AUTO_SCAN_RETRIES = 8;
    const AUTO_SCAN_RETRY_DELAY_MS = 5000;
    const POLL_INTERVAL_MS = 15000;
    const REQUEST_TIMEOUT_MS = 15000;
    const MAX_NICKNAME_LENGTH = 32;

    let stopRequested = false;
    let syncRunning = false;
    let pollTimer = null;

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
        try { GM_setValue(key, value); } catch {}
        try { localStorage.setItem(key, String(value)); } catch {}
    }

    function removeStoredValue(key) {
        try { GM_setValue(key, ''); } catch {}
        try { localStorage.removeItem(key); } catch {}
    }

    function getToken() {
        return String(readStoredValue(TOKEN_KEY, '') || '').trim();
    }

    function getCustomPrefix() {
        return trimNickname(readStoredValue(CUSTOM_PREFIX_KEY, '') || '');
    }

    function applyCustomPrefix(nickname) {
        const base = trimNickname(nickname);
        const prefix = getCustomPrefix();
        if (!prefix) return base;

        // Replace the built-in role prefix when one is present.
        const withoutBuiltInPrefix = base.replace(/^(?:Gump|Recruit)\s+/i, '');
        return trimNickname(`${prefix} ${withoutBuiltInPrefix}`);
    }

    function trimNickname(value) {
        return String(value || '')
            .replace(/[\r\n]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, MAX_NICKNAME_LENGTH);
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
        if (!token) return Promise.reject(new Error('No sync token is configured.'));

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
                    let data = {};
                    try { data = JSON.parse(response.responseText || '{}'); }
                    catch { finish(reject, new Error('Server returned invalid JSON.')); return; }

                    if (response.status < 200 || response.status >= 300) {
                        if (response.status === 401) {
                            removeStoredValue(TOKEN_KEY);
                        }
                        finish(reject, new Error(data.error || `HTTP ${response.status}`));
                        return;
                    }
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

    function getFriendBlocks() {
        const friends = new Map();

        // Steam has used several different friend-list DOM structures.
        // Do not require a particular friend-block class; collect every valid
        // 17-digit Steam ID exposed by the current Friends page.
        for (const node of document.querySelectorAll('[data-steamid]')) {
            const steamId = String(node.getAttribute('data-steamid') || '').trim();
            if (/^\d{17}$/.test(steamId)) {
                const block = node.closest('.friend_block_v2, .friend_block, .friend_block_content') || node;
                friends.set(steamId, block);
            }
        }

        // Also collect IDs from profile links in case Steam does not expose
        // data-steamid on the friend container.
        for (const link of document.querySelectorAll('a[href*="/profiles/"]')) {
            const match = String(link.href || '').match(/\/profiles\/(\d{17})(?:[/?#]|$)/);
            if (!match) continue;
            const steamId = match[1];
            const block = link.closest('.friend_block_v2, .friend_block, .friend_block_content, [data-steamid]') || link;
            friends.set(steamId, block);
        }

        return friends;
    }

    function getStateSteamId(state) {
        const candidates = [state?.steamId, state?.steamID, state?.steam_id, state?.id];
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

    function getSteamFriendName(block) {
        if (!block) return '';

        const selectors = [
            '.friend_block_v2_name',
            '.friend_block_v2_name a',
            '.friend_block_v2_name span',
            '[class*="friend_block"][class*="name"]'
        ];

        for (const selector of selectors) {
            const element = block.querySelector(selector);
            const name = trimNickname(element?.textContent || '');
            if (name) return name;
        }

        return '';
    }

    async function scanFriends() {
        for (let attempt = 1; attempt <= AUTO_SCAN_RETRIES; attempt++) {
            if (stopRequested) throw new Error('Sync stopped.');
            const friends = getFriendBlocks();
            if (friends.size > 0) return friends;
            setStatus('Waiting for Steam friends to finish loading…', `Scan ${attempt}/${AUTO_SCAN_RETRIES}`);
            await sleep(AUTO_SCAN_RETRY_DELAY_MS);
        }
        throw new Error('Steam friend list could not be read. Make sure the Friends page is open and loaded.');
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

        state[steamId] = Date.now();
        writeFriendRequestState(state);

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://steamcommunity.com/actions/AddFriendAjax',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                data: `sessionID=${encodeURIComponent(sessionID)}&steamid=${encodeURIComponent(steamId)}&accept_invite=0`,
                onload: response => {
                    const text = String(response.responseText || '').toLowerCase();
                    if (response.status >= 200 && response.status < 300) {
                        if (/already|pending|request|friend/.test(text)) return resolve('pending');
                        return resolve('sent');
                    }
                    if (/already|pending|request/.test(text)) return resolve('pending');
                    reject(new Error(`Steam friend request failed for ${steamId}.`));
                },
                onerror: () => reject(new Error(`Steam friend request failed for ${steamId}.`))
            });
        });
    }

    async function setSteamNickname(steamId, nickname) {
        const sessionID = getSessionId();
        if (!sessionID) throw new Error('Steam session ID was not found.');

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: `https://steamcommunity.com/profiles/${steamId}/ajaxsetnickname/`,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                data: `nickname=${encodeURIComponent(trimNickname(nickname))}&sessionid=${encodeURIComponent(sessionID)}`,
                onload: response => {
                    if (response.status < 200 || response.status >= 300) {
                        reject(new Error(`Steam nickname update failed for ${steamId} (HTTP ${response.status}).`));
                        return;
                    }
                    try {
                        const data = JSON.parse(response.responseText || '{}');
                        if (Number(data.success) !== 1) {
                            reject(new Error(`Steam nickname update failed for ${steamId}.`));
                            return;
                        }
                    } catch {
                        reject(new Error(`Steam nickname update returned invalid data for ${steamId}.`));
                        return;
                    }
                    resolve();
                },
                onerror: () => reject(new Error(`Steam nickname update failed for ${steamId}.`))
            });
        });
    }

    function stateSignature(states) {
        return states
            .map(item => ({ steamId: getStateSteamId(item), nickname: getStateNickname(item) }))
            .filter(item => item.steamId && item.nickname)
            .sort((a, b) => a.steamId.localeCompare(b.steamId))
            .map(item => `${item.steamId}|${item.nickname}`)
            .join('\n');
    }

    async function syncNicknames(force = false) {
        if (syncRunning) return;
        if (!getToken()) {
            setStatus('No sync token configured.');
            return;
        }
        if (!isFriendsPage()) {
            setStatus('Open Steam → Friends to run nickname sync.');
            return;
        }

        syncRunning = true;
        stopRequested = false;
        setButtonDisabled(true);

        try {
            setStatus('Loading Discord sync data…');
            const data = await apiRequest('GET', `${SYNC_API_URL}/client/all-state`);

            const currentSteamId = getSteamId();
            if (!currentSteamId || data.steamId !== currentSteamId) {
                throw new Error('This sync token is not for the Steam account currently signed in.');
            }
            if (data.ok !== true || data.complete !== true || !Array.isArray(data.states)) {
                throw new Error('Sync data is incomplete. No nicknames were changed.');
            }
            if (Number(data.memberCount || 0) > 0 && Number(data.fetchedMemberCount || data.memberCount) < Number(data.memberCount)) {
                throw new Error('Discord member data is incomplete. No nicknames were changed.');
            }
            if (data.states.length === 0 && Number(data.memberCount || 0) > 0) {
                throw new Error('Discord returned an empty sync state. No nicknames were changed.');
            }

            const friends = await scanFriends();
            const desired = new Map();
            const unresolved = [];

            for (const state of data.states) {
                const steamId = getStateSteamId(state);
                if (!steamId || steamId === currentSteamId) continue;

                const friendBlock = friends.get(steamId);
                if (!friendBlock) {
                    if (state?.role) desired.set(steamId, null);
                    continue;
                }

                const steamName = getSteamFriendName(friendBlock);
                if (!steamName) {
                    unresolved.push(steamId);
                    continue;
                }

                if (state?.role) {
                    desired.set(steamId, applyCustomPrefix(`${state.role} ${steamName}`));
                } else {
                    desired.set(steamId, '');
                }
            }

            const signature = stateSignature(
                [...desired.entries()].map(([steamId, nickname]) => ({
                    steamId,
                    nickname: nickname || ''
                }))
            );
            const previous = String(readStoredValue(LAST_COMPLETED_SIGNATURE_KEY, '') || '');
            if (!force && signature === previous) {
                setStatus('Already synchronized.');
                return;
            }

            const matching = [...desired.keys()].filter(steamId => steamId !== currentSteamId && friends.has(steamId) && desired.get(steamId) !== null);
            setStatus(
                `Found ${friends.size} Steam friend(s) and ${desired.size} Discord-linked friend(s).`,
                `${matching.length} matching friend(s) ready to update.`
            );

            const missing = [];
            for (const steamId of desired.keys()) {
                if (steamId === currentSteamId) continue;
                if (!friends.has(steamId)) missing.push(steamId);
            }

            if (missing.length) {
                let requested = 0;
                for (const steamId of missing) {
                    if (stopRequested) throw new Error('Sync stopped.');
                    const result = await sendSteamFriendRequest(steamId);
                    if (result === 'sent') requested++;
                    await sleep(500);
                }
                setStatus(
                    `Requested ${requested} missing friend(s).`,
                    `${missing.length} Discord-linked friend(s) are not currently on your Steam friends list.`
                );
            }

            const entries = [...desired.entries()].filter(
                ([steamId, nickname]) =>
                    steamId !== currentSteamId &&
                    friends.has(steamId) &&
                    nickname !== null
            );
            let completed = 0;

            if (entries.length === 0) {
                throw new Error(
                    `No matching Steam friends to update. Steam found ${friends.size} friend(s), but none of the ${desired.size} Discord-linked Steam IDs could be resolved.`
                );
            }

            for (const [steamId, nickname] of entries) {
                if (stopRequested) throw new Error('Sync stopped.');
                completed++;
                setStatus('Syncing nicknames…', `Processing ${completed} / ${entries.length}`);
                await setSteamNickname(steamId, nickname);
                await sleep(500);
            }

            writeStoredValue(LAST_COMPLETED_SIGNATURE_KEY, signature);
            setStatus(`Sync complete — ${entries.length} nickname(s) updated.`);
            await sleep(2500);
            location.reload();
        } catch (error) {
            setStatus(error.message || 'Sync failed. No automatic nickname clearing was performed.');
        } finally {
            syncRunning = false;
            setButtonDisabled(false);
        }
    }

    async function clearAllFriendNicknames() {
        if (syncRunning) return;
        if (!isFriendsPage()) {
            setStatus('Open Steam → Friends first.');
            return;
        }

        if (!confirm('Remove all local nicknames from your Steam friends? This is an explicit manual action.')) return;

        syncRunning = true;
        stopRequested = false;
        setButtonDisabled(true);

        try {
            const currentSteamId = getSteamId();
            if (!currentSteamId) {
                throw new Error('Could not determine your Steam ID. Open Steam → Friends and try again.');
            }

            const scannedFriends = await scanFriends();

            // Only process valid 17-digit Steam IDs and NEVER modify the logged-in user's own nickname.
            const friends = new Map(
                [...scannedFriends.entries()].filter(([steamId]) => {
                    const id = String(steamId || '').trim();
                    return /^\d{17}$/.test(id) && id !== currentSteamId;
                })
            );

            let completed = 0;
            let failed = 0;
            for (const steamId of friends.keys()) {
                if (stopRequested) throw new Error('Sync stopped.');
                completed++;
                setStatus(
                    'Removing friend nicknames…',
                    `Processing ${completed} / ${friends.size}${failed ? ` — ${failed} failed` : ''}`
                );
                try {
                    await setSteamNickname(steamId, '');
                } catch (error) {
                    failed++;
                }
                await sleep(500);
            }
            removeStoredValue(LAST_COMPLETED_SIGNATURE_KEY);
            writeStoredValue(RESYNC_AFTER_CLEAR_KEY, '1');
            const successCount = friends.size - failed;
            setStatus(
                `Removed local nicknames from ${successCount} friend(s).${failed ? ` ${failed} friend(s) could not be updated.` : ''}`,
                'The page will automatically refresh and restore the Discord nicknames.'
            );
            await sleep(2500);
            location.reload();
        } catch (error) {
            setStatus(error.message || 'Could not remove friend nicknames.');
        } finally {
            syncRunning = false;
            setButtonDisabled(false);
        }
    }

    function setupCustomPrefix() {
        const current = getCustomPrefix();
        const value = prompt(
            'Enter your custom Steam nickname prefix.\n\n' +
            'Example: Family\n\n' +
            'Leave blank to use the Discord Gump/Recruit prefix.',
            current
        );
        if (value === null) return;

        const prefix = trimNickname(value);
        writeStoredValue(CUSTOM_PREFIX_KEY, prefix);

        if (prefix) {
            setStatus(`Custom prefix saved: ${prefix}`, 'Syncing nicknames with your custom prefix…');
        } else {
            setStatus('Custom prefix cleared.', 'Restoring the Discord Gump/Recruit prefixes…');
        }

        syncNicknames(true).catch(error => setStatus(error.message || 'Custom prefix sync failed.'));
    }

    function setupToken() {
        const current = getToken();
        const token = prompt('Paste the personal token generated by /sync-setup in Discord.', current);
        if (token === null) return;
        const value = token.trim();
        if (!/^[a-f0-9]{64}$/i.test(value)) {
            setStatus('Invalid token. Tokens are exactly 64 hexadecimal characters.');
            return;
        }
        writeStoredValue(TOKEN_KEY, value);
        setStatus('Token saved. Testing sync…');
        syncNicknames(true).catch(error => setStatus(error.message || 'Token test failed.'));
    }

    function buildUI() {
        if (document.querySelector('#discord-steam-sync-panel')) return;

        GM_addStyle(`
            #discord-steam-sync-panel{position:fixed;right:18px;bottom:18px;z-index:999999;width:310px;background:#171d25;color:#d6d7d8;border:1px solid #3b4450;border-radius:6px;box-shadow:0 8px 30px rgba(0,0,0,.55);font:14px Arial,sans-serif}
            #discord-steam-sync-header{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:#1b2838;border-bottom:1px solid #3b4450;font-weight:700}
            #discord-steam-sync-close{background:none!important;border:0!important;color:#aaa!important;font-size:18px!important;cursor:pointer!important;padding:0 4px!important}
            #discord-steam-sync-body{padding:12px}
            #discord-steam-sync-panel button:not(#discord-steam-sync-close){width:100%;margin:0 0 8px;padding:9px 10px;border:0;border-radius:3px;background:#66c0f4;color:#10212d;font-weight:700;cursor:pointer}
            #discord-steam-sync-panel button:not(#discord-steam-sync-close):hover{filter:brightness(1.08)}
            #discord-steam-sync-setup{background:#183a63!important;color:#fff!important}
            #discord-steam-sync-clear-friends{background:#d94141!important;color:#fff!important}
            #discord-steam-sync-stop{background:#f2c94c!important;color:#1f1f1f!important}
            #discord-steam-sync-panel button:disabled{opacity:.5;cursor:not-allowed}
            #discord-steam-sync-status{margin-top:4px;line-height:1.35;min-height:38px;color:#d7d7d7}
            #discord-steam-sync-progress{margin-top:5px;color:#8f98a0;font-size:12px}
        `);

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
                <button id="discord-steam-sync-prefix">🏷️ Set Custom Prefix</button>
                <button id="discord-steam-sync-clear-friends">🧹 Remove All Friend Nicknames</button>
                <button id="discord-steam-sync-stop">🛑 Stop Current Sync</button>
                <div id="discord-steam-sync-status"></div>
                <div id="discord-steam-sync-progress"></div>
            </div>
        `;
        document.body.appendChild(panel);

        panel.querySelector('#discord-steam-sync-close').addEventListener('click', () => panel.remove());
        panel.querySelector('#discord-steam-sync-button').addEventListener('click', () => syncNicknames(true));
        panel.querySelector('#discord-steam-sync-setup').addEventListener('click', setupToken);
        panel.querySelector('#discord-steam-sync-prefix').addEventListener('click', setupCustomPrefix);
        panel.querySelector('#discord-steam-sync-clear-friends').addEventListener('click', clearAllFriendNicknames);
        panel.querySelector('#discord-steam-sync-stop').addEventListener('click', () => {
            stopRequested = true;
            setStatus('Stopping after the current request…');
        });

        setStatus(getToken() ? (isFriendsPage() ? 'Ready.' : 'Open Steam → Friends to sync.') : 'Set your personal sync token first.');
    }

    function startPolling() {
        clearInterval(pollTimer);
        pollTimer = setInterval(() => {
            if (document.hidden || !getToken() || !isFriendsPage() || syncRunning) return;
            syncNicknames(false).catch(() => {});
        }, POLL_INTERVAL_MS);
    }

    GM_registerMenuCommand('Set Discord Steam Sync Token', setupToken);
    GM_registerMenuCommand('Set Custom Nickname Prefix', setupCustomPrefix);
    GM_registerMenuCommand('Sync All Nicknames', () => syncNicknames(true));
    GM_registerMenuCommand('Remove All Friend Nicknames', clearAllFriendNicknames);

    buildUI();
    startPolling();

    setTimeout(() => {
        if (!getToken() || !isFriendsPage()) return;

        const resyncAfterClear = String(readStoredValue(RESYNC_AFTER_CLEAR_KEY, '') || '') === '1';
        if (resyncAfterClear) {
            removeStoredValue(RESYNC_AFTER_CLEAR_KEY);
            setStatus('Restoring Discord nicknames after Remove All…');
            syncNicknames(true).catch(() => {});
            return;
        }

        syncNicknames(false).catch(() => {});
    }, 2500);
})();
