// ==UserScript==

// @name         Discord Steam Nickname Sync
// @namespace    discord-steam-sync
// @version      10.2.3
// @description  Sync Steam friend local nicknames from Discord roles.
// @homepageURL  https://github.com/RustyGumpers/steam-link
// @supportURL   https://github.com/RustyGumpers/steam-link/issues
// @updateURL    https://raw.githubusercontent.com/RustyGumpers/steam-link/main/Discord-Steam-Nickname-Sync.user.js
// @downloadURL  https://raw.githubusercontent.com/RustyGumpers/steam-link/main/Discord-Steam-Nickname-Sync.user.js
// @match        https://steamcommunity.com/my/friends*
// @match        https://steamcommunity.com/profiles/*/friends*
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
    const LAST_COMPLETED_SIGNATURE_KEY = 'discordSteamSyncLastCompletedSignatureV11';
    const RESYNC_AFTER_CLEAR_KEY = 'discordSteamSyncResyncAfterClearV1';
    const POST_SYNC_RELOAD_KEY = 'discordSteamSyncPostSyncReloadV1';
    const FRIEND_REQUESTS_KEY = 'discordSteamSyncFriendRequestsV1';
    const NICKNAME_FAILURES_KEY = 'discordSteamSyncNicknameFailuresV1';
    const FRIEND_REQUEST_COOLDOWN_MS = 24 * 60 * 60 * 1000;
    const NICKNAME_FAILURE_RETRY_MS = 5 * 60 * 1000;
    const AUTO_SCAN_RETRIES = 8;
    const AUTO_SCAN_RETRY_DELAY_MS = 5000;
    const POLL_INTERVAL_MS = 60000;
    const REQUEST_TIMEOUT_MS = 15000;
    const MAX_NICKNAME_LENGTH = 32;
    const FRIEND_REQUEST_MIN_INTERVAL_MS = 1500;

    let stopRequested = false;
    let syncRunning = false;
    let pollTimer = null;
    const activeRequestAborts = new Set();

    function readStoredValue(key, fallback = '') {
        try {
            const value = GM_getValue(key, undefined);
            if (value !== undefined && value !== null) return value;
        } catch {}
        return fallback;
    }

    function writeStoredValue(key, value) {
        try { GM_setValue(key, value); } catch {}
    }

    function removeStoredValue(key) {
        try { GM_setValue(key, ''); } catch {}
    }

    function migrateLegacyTokenStorage() {
        try {
            const existing = String(GM_getValue(TOKEN_KEY, '') || '').trim();
            if (existing) return;
            const legacy = String(localStorage.getItem(TOKEN_KEY) || '').trim();
            if (/^[a-f0-9]{64}$/i.test(legacy)) GM_setValue(TOKEN_KEY, legacy);
            if (legacy) localStorage.removeItem(TOKEN_KEY);
        } catch {}
    }

    function getToken() {
        return String(readStoredValue(TOKEN_KEY, '') || '').trim();
    }

    migrateLegacyTokenStorage();

    function getCustomPrefix() {
        return trimNickname(readStoredValue(CUSTOM_PREFIX_KEY, '') || '');
    }

    function trimNickname(value) {
        return String(value || '')
            .replace(/[\r\n]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, MAX_NICKNAME_LENGTH);
    }

    function getSteamId() {
        if (/^\d{17}$/.test(String(window.g_steamID || ''))) {
            return String(window.g_steamID);
        }

        const html = document.documentElement.innerHTML;
        const patterns = [
            /g_steamID\s*=\s*["'](\d{17})["']/,
            /g_steamID\s*=\s*"?(\d{17})"?/
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
        // Nickname changes use the logged-in account's Steam session. Never
        // operate on another user's public friends page.
        return (
            path === '/my/friends' ||
            path === '/my/friends/' ||
            /^\/profiles\/\d{17}\/friends\/?$/.test(path)
        );
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
            let request = null;

            const cleanup = () => {
                if (request) activeRequestAborts.delete(request);
            };

            const finish = (fn, value) => {
                if (settled) return;
                settled = true;
                cleanup();
                fn(value);
            };

            request = GM_xmlhttpRequest({
                method,
                url,
                timeout: REQUEST_TIMEOUT_MS,
                headers: {
                    Accept: 'application/json',
                    Authorization: `Bearer ${token}`,
                    ...(body ? { 'Content-Type': 'application/json' } : {})
                },
                data: body ? JSON.stringify(body) : undefined,
                onload: response => {
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
                onerror: () => finish(reject, new Error('Network request failed.')),
                onabort: () => finish(reject, new Error('Request aborted.')),
                ontimeout: () => finish(reject, new Error('Request timed out.'))
            });

            if (!settled && request?.abort) {
                activeRequestAborts.add(request);
            }
        });
    }

    function getFriendBlocks() {
        const friends = new Map();

        // Only collect IDs from actual Steam friend-entry containers.
        for (const node of document.querySelectorAll('.friend_block_v2[data-steamid], .friend_block[data-steamid]')) {
            const steamId = String(node.getAttribute('data-steamid') || '').trim();
            if (/^\d{17}$/.test(steamId)) friends.set(steamId, node);
        }

        // Some Steam layouts expose the ID only on the profile link. Keep the
        // fallback scoped to known friend-entry containers so unrelated profile
        // links elsewhere on the page cannot be mistaken for friends.
        for (const link of document.querySelectorAll('.friend_block_v2 a[href*="/profiles/"], .friend_block a[href*="/profiles/"]')) {
            const match = String(link.href || '').match(/\/profiles\/(\d{17})(?:[/?#]|$)/);
            if (!match) continue;
            const block = link.closest('.friend_block_v2, .friend_block');
            if (block) friends.set(match[1], block);
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

    function getSteamLocalNickname(friendBlock) {
        if (!friendBlock) return '';

        // Steam does not expose local nicknames consistently across all
        // Friends-page layouts. Use only explicit nickname attributes/elements;
        // never guess from the persona/display name.
        const explicit = friendBlock.querySelector(
            '[data-nickname], .friend_block_content [data-nickname], ' +
            '.friend_block_content .friend_block_nickname, ' +
            '.friend_block_content .nickname'
        );
        if (!explicit) return '';

        return trimNickname(
            explicit.getAttribute('data-nickname') ||
            explicit.getAttribute('title') ||
            explicit.textContent ||
            ''
        );
    }

    function getSteamDisplayName(friendBlock) {
        if (!friendBlock) return '';

        // Steam's friend blocks expose the persona name in data-search.
        // Prefer that explicit field because it is tied to the friend entry
        // itself, then use dedicated persona elements as fallbacks.
        const dataSearch = String(friendBlock.getAttribute('data-search') || '').trim();
        if (dataSearch) {
            const first = dataSearch.split(/\s*;\s*/)[0];
            const name = trimNickname(first.replace(/^\*+/, ''));
            if (name) return name;
        }

        const persona = friendBlock.querySelector(
            '.friend_block_content a.friend_block_content_link, ' +
            '.friend_block_content .friend_block_persona, ' +
            '.friend_block_content a'
        );
        if (persona) {
            const name = trimNickname(
                persona.getAttribute('data-search') ||
                persona.getAttribute('title') ||
                persona.textContent ||
                ''
            );
            if (name) return name;
        }

        const content = friendBlock.querySelector('.friend_block_content');
        if (content) {
            const firstLine = String(content.innerText || content.textContent || '')
                .split(/\r?\n/)[0]
                .replace(/^\*+/, '');
            const name = trimNickname(firstLine);
            if (firstLine && name) return name;
        }

        return '';
    }

    function getRolePrefix(state) {
        const role = String(state?.role || '').trim().toLowerCase();
        if (role === 'gump') return 'Gump';
        if (role === 'recruit') return 'Recruit';
        return '';
    }

    function buildFinalNickname(state, friendBlock) {
        const rolePrefix = getRolePrefix(state);

        // Roster members use their current Steam display name. This makes
        // Steam-name changes part of the synchronization signature.
        if (rolePrefix) {
            const steamName = getSteamDisplayName(friendBlock);
            if (!steamName) return '';

            const customPrefix = getCustomPrefix();
            const prefix = customPrefix || rolePrefix;
            return trimNickname(`${prefix} ${steamName}`);
        }

        // Users who are no longer Recruit/Gump retain the bot's authoritative
        // plain Discord username, matching the server's cleanup state.
        return trimNickname(state?.nickname || '');
    }

    function isSteamFriendListRendered() {
        // Do not treat the generic friends-list container as "loaded": Steam
        // can create that container before its friend blocks arrive. Only
        // explicit empty-state text is strong enough to conclude that there
        // are genuinely zero friends.
        const text = String(document.body?.innerText || '').toLowerCase();
        return (
            text.includes('you have no friends') ||
            text.includes('no friends to display') ||
            text.includes('your friends list is empty')
        );
    }

    async function scanFriends() {
        for (let attempt = 1; attempt <= AUTO_SCAN_RETRIES; attempt++) {
            if (stopRequested) throw new Error('Sync stopped.');
            const friends = getFriendBlocks();
            if (friends.size > 0) return friends;

            // Empty-state text is the definitive zero-friend case. If Steam
            // has not rendered either friend entries or an explicit empty
            // state yet, keep waiting rather than guessing.
            if (isSteamFriendListRendered()) return friends;

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

    function readNicknameFailureState() {
        try {
            const raw = readStoredValue(NICKNAME_FAILURES_KEY, '{}');
            const parsed = JSON.parse(raw || '{}');
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            return {};
        }
    }

    function writeNicknameFailureState(state) {
        writeStoredValue(NICKNAME_FAILURES_KEY, JSON.stringify(state));
    }

    function isNicknameFailureThrottled(steamId, force) {
        if (force) return false;
        const state = readNicknameFailureState();
        const lastFailed = Number(state[steamId] || 0);
        return lastFailed > 0 && Date.now() - lastFailed < NICKNAME_FAILURE_RETRY_MS;
    }

    function recordNicknameFailure(steamId) {
        const state = readNicknameFailureState();
        state[steamId] = Date.now();
        writeNicknameFailureState(state);
    }

    function clearNicknameFailure(steamId) {
        const state = readNicknameFailureState();
        if (!(steamId in state)) return;
        delete state[steamId];
        writeNicknameFailureState(state);
    }

    async function sendSteamFriendRequest(steamId) {
        const sessionID = getSessionId();
        if (!sessionID) throw new Error('Steam session ID was not found.');

        const state = readFriendRequestState();
        const last = Number(state[steamId] || 0);
        if (Date.now() - last < FRIEND_REQUEST_COOLDOWN_MS) return 'throttled';

        return new Promise((resolve, reject) => {
            let settled = false;
            let request = null;

            const cleanup = () => {
                if (request) activeRequestAborts.delete(request);
            };

            const finish = (fn, value) => {
                if (settled) return;
                settled = true;
                cleanup();
                fn(value);
            };

            const recordConfirmedCooldown = result => {
                state[steamId] = Date.now();
                writeFriendRequestState(state);
                finish(resolve, result);
            };

            request = GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://steamcommunity.com/actions/AddFriendAjax',
                timeout: REQUEST_TIMEOUT_MS,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                data: `sessionID=${encodeURIComponent(sessionID)}&steamid=${encodeURIComponent(steamId)}&accept_invite=0`,
                onload: response => {
                    const responseText = String(response.responseText || '');
                    const text = responseText.toLowerCase();
                    let data = null;
                    try {
                        data = JSON.parse(responseText || '{}');
                    } catch {}

                    const invited = Array.isArray(data?.invited)
                        ? data.invited.map(value => String(value))
                        : [];
                    const sentSuccessfully =
                        Number(data?.success) === 1 &&
                        invited.includes(String(steamId));

                    // Only recognize narrowly worded states that indicate an
                    // existing friendship/request. Never treat the generic
                    // word "request" as confirmation.
                    const explicitlyPending =
                        /already\s+(?:a\s+)?friend/.test(text) ||
                        /already\s+(?:sent|pending)/.test(text) ||
                        /friend\s+request[^.\n]*pending/.test(text) ||
                        /pending[^.\n]*friend\s+request/.test(text) ||
                        /invitation[^.\n]*pending/.test(text);

                    if (response.status < 200 || response.status >= 300) {
                        if (explicitlyPending) {
                            recordConfirmedCooldown('pending');
                            return;
                        }
                        finish(reject, new Error(`Steam friend request failed for ${steamId}.`));
                        return;
                    }

                    if (sentSuccessfully) {
                        recordConfirmedCooldown('sent');
                        return;
                    }

                    if (explicitlyPending) {
                        recordConfirmedCooldown('pending');
                        return;
                    }

                    finish(reject, new Error(`Steam did not confirm the friend request for ${steamId}.`));
                },
                onerror: () => finish(reject, new Error(`Steam friend request failed for ${steamId}.`)),
                onabort: () => finish(reject, new Error('Friend request aborted.')),
                ontimeout: () => finish(reject, new Error(`Steam friend request timed out for ${steamId}.`))
            });

            if (!settled && request?.abort) activeRequestAborts.add(request);
        });
    }

    async function setSteamNickname(steamId, nickname) {
        const sessionID = getSessionId();
        if (!sessionID) throw new Error('Steam session ID was not found.');

        return new Promise((resolve, reject) => {
            let settled = false;
            let request = null;

            const cleanup = () => {
                if (request) activeRequestAborts.delete(request);
            };

            const finish = (fn, value) => {
                if (settled) return;
                settled = true;
                cleanup();
                fn(value);
            };

            request = GM_xmlhttpRequest({
                method: 'POST',
                url: `https://steamcommunity.com/profiles/${steamId}/ajaxsetnickname/`,
                timeout: REQUEST_TIMEOUT_MS,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                data: `nickname=${encodeURIComponent(trimNickname(nickname))}&sessionid=${encodeURIComponent(sessionID)}`,
                onload: response => {
                    if (response.status < 200 || response.status >= 300) {
                        finish(reject, new Error(`Steam nickname update failed for ${steamId} (HTTP ${response.status}).`));
                        return;
                    }
                    try {
                        const data = JSON.parse(response.responseText || '{}');
                        if (Number(data.success) !== 1) {
                            finish(reject, new Error(`Steam nickname update failed for ${steamId}.`));
                            return;
                        }
                    } catch {
                        finish(reject, new Error(`Steam nickname update returned invalid data for ${steamId}.`));
                        return;
                    }
                    finish(resolve);
                },
                onerror: () => finish(reject, new Error(`Steam nickname update failed for ${steamId}.`)),
                onabort: () => finish(reject, new Error('Nickname update aborted.')),
                ontimeout: () => finish(reject, new Error(`Steam nickname update timed out for ${steamId}.`))
            });

            if (!settled && request?.abort) activeRequestAborts.add(request);
        });
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
            const unresolvedNames = [];

            for (const state of data.states) {
                const steamId = getStateSteamId(state);
                if (!steamId || steamId === currentSteamId) continue;

                const friendBlock = friends.get(steamId);
                if (!friendBlock) {
                    desired.set(steamId, { nickname: null, reason: 'not-friend' });
                    continue;
                }

                const nickname = buildFinalNickname(state, friendBlock);
                if (!nickname) {
                    desired.set(steamId, { nickname: null, reason: 'name-unresolved' });
                    unresolvedNames.push(steamId);
                    continue;
                }

                desired.set(steamId, { nickname, reason: '' });
            }

            const completedEntries = [...desired.entries()]
                .filter(([, item]) => item?.nickname)
                .map(([steamId, item]) => [steamId, item.nickname]);

            const completedSignature = completedEntries
                .map(([steamId, nickname]) => `${steamId}|${nickname}`)
                .sort()
                .join('\n');

            const previousCompleted = String(readStoredValue(LAST_COMPLETED_SIGNATURE_KEY, '') || '');
            const missingFriends = [...desired.entries()]
                .filter(([, item]) => item?.reason === 'not-friend')
                .map(([steamId]) => steamId);
            const hasUnresolvedNames = unresolvedNames.length > 0;
            const hasMissing = missingFriends.length > 0 || hasUnresolvedNames;
            let shouldUpdateMatching = force || completedSignature !== previousCompleted;

            if (!force && !hasMissing && !shouldUpdateMatching) {
                for (const [steamId, nickname] of completedEntries) {
                    const friendBlock = friends.get(steamId);
                    const localNickname = getSteamLocalNickname(friendBlock);
                    if (localNickname && localNickname !== nickname) {
                        // The stored signature says the desired nickname was
                        // previously completed, but Steam explicitly exposes a
                        // different local nickname now. Treat that as a real
                        // mismatch and queue the nickname for correction.
                        shouldUpdateMatching = true;
                        break;
                    }
                }

                if (!shouldUpdateMatching) {
                    setStatus('Already synchronized.');
                    return;
                }
            }

            const entries = shouldUpdateMatching
                ? completedEntries.filter(([steamId]) => steamId !== currentSteamId)
                : [];

            if (missingFriends.length) {
                let requested = 0;
                let requestFailures = 0;

                for (const steamId of missingFriends) {
                    if (stopRequested) throw new Error('Sync stopped.');

                    let result = 'throttled';
                    try {
                        result = await sendSteamFriendRequest(steamId);
                        if (result === 'sent') requested++;
                    } catch {
                        requestFailures++;
                    }

                    // Space actual Steam requests apart. A throttled account
                    // did not make a request, so it does not need the delay.
                    if (result !== 'throttled' && !stopRequested) {
                        await sleep(FRIEND_REQUEST_MIN_INTERVAL_MS);
                    }
                }

                if (requestFailures) {
                    setStatus(
                        'Continuing nickname sync; some friend requests failed.',
                        `${requested} new request(s) sent, ${requestFailures} request(s) failed and can be retried later.`
                    );
                }
            }

            let completed = 0;
            let failedNicknames = [];
            let deferredNicknames = [];

            for (const [steamId, nickname] of entries) {
                if (stopRequested) throw new Error('Sync stopped.');

                if (isNicknameFailureThrottled(steamId, force)) {
                    deferredNicknames.push(steamId);
                    continue;
                }

                setStatus(
                    'Syncing nicknames…',
                    `Processing ${completed + 1} / ${entries.length}`
                );

                try {
                    await setSteamNickname(steamId, nickname);
                    clearNicknameFailure(steamId);
                    completed++;
                } catch {
                    recordNicknameFailure(steamId);
                    failedNicknames.push(steamId);
                }

                await sleep(500);
            }

            if (unresolvedNames.length) {
                const listed = unresolvedNames.slice(0, 5).join(', ');
                const suffix = unresolvedNames.length > 5 ? '…' : '';
                setStatus(
                    'Sync finished with unresolved Steam names.',
                    `${unresolvedNames.length} linked account(s) could not be read from the Steam Friends page: ${listed}${suffix}`
                );
            }

            if (failedNicknames.length) {
                const listed = failedNicknames.slice(0, 5).join(', ');
                const suffix = failedNicknames.length > 5 ? '…' : '';
                setStatus(
                    'Sync finished with nickname update failures.',
                    `${failedNicknames.length} nickname(s) failed and will be retried: ${listed}${suffix}`
                );
            }

            if (deferredNicknames.length && !failedNicknames.length && !unresolvedNames.length) {
                setStatus(
                    'Some nickname retries are temporarily delayed.',
                    `${deferredNicknames.length} nickname(s) recently failed and will be retried automatically.`
                );
            }

            const fullySuccessful =
                missingFriends.length === 0 &&
                unresolvedNames.length === 0 &&
                failedNicknames.length === 0 &&
                deferredNicknames.length === 0 &&
                entries.length === completedEntries.length;

            if (fullySuccessful) {
                writeStoredValue(LAST_COMPLETED_SIGNATURE_KEY, completedSignature);
                removeStoredValue(RESYNC_AFTER_CLEAR_KEY);
                // Mark this reload as an intentional post-sync reload. The
                // startup handler consumes this marker so the same successful
                // sync is not immediately started again after page refresh.
                writeStoredValue(POST_SYNC_RELOAD_KEY, String(Date.now()));
                setStatus(`Sync complete — ${completed} nickname(s) updated.`, 'All linked Steam nicknames are synchronized.');
                await sleep(2500);
                location.reload();
                return;
            }

            // Never mark an incomplete run as fully synchronized. This keeps
            // failed nickname updates, unresolved names, and missing friends
            // eligible for the next automatic/manual retry.
            removeStoredValue(LAST_COMPLETED_SIGNATURE_KEY);

            if (!entries.length && missingFriends.length === 0 && unresolvedNames.length === 0) {
                setStatus(
                    'No Discord-linked Steam accounts are currently available to update.',
                    'No nickname changes were made.'
                );
            }
        } catch (error) {
            // A user-initiated stop can happen after some nicknames have
            // already been changed. Never leave the previous completed
            // signature in place, or the next automatic run could incorrectly
            // assume a force-sync was completed.
            if (stopRequested) {
                removeStoredValue(LAST_COMPLETED_SIGNATURE_KEY);
                setStatus('Sync stopped.', 'The completed signature was cleared so the next sync will retry all required nicknames.');
            } else {
                setStatus(error.message || 'Sync failed. No automatic nickname clearing was performed.');
            }
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
                } catch {
                    failed++;
                }
                await sleep(500);
            }

            removeStoredValue(LAST_COMPLETED_SIGNATURE_KEY);
            removeStoredValue(NICKNAME_FAILURES_KEY);

            if (failed > 0) {
                // Do not schedule automatic restoration when clearing itself
                // did not complete. The user can retry Remove All safely.
                removeStoredValue(RESYNC_AFTER_CLEAR_KEY);
                setStatus(
                    `Removed local nicknames from ${friends.size - failed} friend(s).`,
                    `${failed} friend(s) could not be cleared. No automatic restoration was started.`
                );
                return;
            }

            // Keep this flag until the restoration sync itself reports complete.
            // That makes a failed restoration eligible for retry.
            writeStoredValue(RESYNC_AFTER_CLEAR_KEY, '1');
            setStatus(
                `Removed local nicknames from ${friends.size} friend(s).`,
                'The page will automatically refresh and restore the Discord nicknames.'
            );
            await sleep(2500);
            location.reload();
        } catch (error) {
            // If Remove All was stopped after some nicknames were already
            // cleared, the old completed signature is no longer trustworthy.
            // Clear it so the next normal sync cannot incorrectly report that
            // the friends are already synchronized.
            if (stopRequested) {
                removeStoredValue(LAST_COMPLETED_SIGNATURE_KEY);
                removeStoredValue(RESYNC_AFTER_CLEAR_KEY);
                setStatus('Nickname removal stopped.', 'The sync signature was cleared so the next sync will retry the required nicknames.');
            } else {
                setStatus(error.message || 'Could not remove friend nicknames.');
            }
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
        const token = prompt('Paste your personal 64-character sync token generated by /sync-setup in Discord. Keep this token private.', '');
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
            #discord-steam-sync-setup{background:#58A864!important;color:#fff!important}
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

            for (const abort of [...activeRequestAborts]) {
                try { abort(); } catch {}
            }

            setStatus('Stopping current sync…');
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

        const postSyncReloadAt = Number(readStoredValue(POST_SYNC_RELOAD_KEY, '') || 0);
        if (postSyncReloadAt > 0) {
            removeStoredValue(POST_SYNC_RELOAD_KEY);
            if (Date.now() - postSyncReloadAt < 60000) {
                setStatus('Sync complete. Waiting for changes…', 'Automatic sync is paused briefly after the page refresh.');
                return;
            }
            // A stale marker should never suppress normal synchronization.
            // Clear it and continue with the regular startup check.
            removeStoredValue(POST_SYNC_RELOAD_KEY);
        }

        const resyncAfterClear = String(readStoredValue(RESYNC_AFTER_CLEAR_KEY, '') || '') === '1';
        if (resyncAfterClear) {
            setStatus('Restoring Discord nicknames after Remove All…');
            syncNicknames(true).catch(() => {});
            return;
        }

        syncNicknames(false).catch(() => {});
    }, 2500);
})();
