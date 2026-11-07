// ==UserScript==

// @name         Discord Steam Nickname Sync
// @namespace    discord-steam-sync
// @version      11.25
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
    const LAST_COMPLETED_SIGNATURE_KEY = 'discordSteamSyncLastCompletedSignatureV10';
    const RESYNC_AFTER_CLEAR_KEY = 'discordSteamSyncResyncAfterClearV1';
    const FRIEND_REQUESTS_KEY = 'discordSteamSyncFriendRequestsV1';
    const SYNC_REPORT_KEY = 'discordSteamSyncLastReportV1';
    const FRIEND_REQUEST_COOLDOWN_MS = 24 * 60 * 60 * 1000;
    const AUTO_SCAN_RETRIES = 8;
    const AUTO_SCAN_RETRY_DELAY_MS = 5000;
    const POLL_INTERVAL_MS = 15000;
    const FRIEND_COVERAGE_RECHECK_MS = 60000;
    const REQUEST_TIMEOUT_MS = 15000;
    const NICKNAME_VERIFY_ATTEMPTS = 3;
    const NICKNAME_VERIFY_DELAY_MS = 1500;
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

    function migrateLegacyPrefix() {
        const legacy = trimNickname(readStoredValue(LEGACY_CUSTOM_PREFIX_KEY, '') || '');
        if (!legacy) return;

        const gumpCurrent = getCustomPrefix('Gump');
        const recruitCurrent = getCustomPrefix('Recruit');
        if (gumpCurrent || recruitCurrent) {
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

    function renderSyncReport(report) {
        const panel = document.querySelector('#discord-steam-sync-panel');
        if (!panel || !report || !Array.isArray(report.sections)) return;
        let container = panel.querySelector('#discord-steam-sync-report');
        if (!container) {
            container = document.createElement('div');
            container.id = 'discord-steam-sync-report';
            panel.querySelector('#discord-steam-sync-body')?.appendChild(container);
        }
        if (!container) return;
        container.replaceChildren();
        const heading = document.createElement('div');
        heading.className = 'sync-report-heading';
        heading.textContent = report.title || 'Sync Results';
        container.appendChild(heading);
        for (const section of report.sections) {
            const sectionEl = document.createElement('section');
            sectionEl.className = 'sync-report-section';
            const title = document.createElement('div');
            title.className = 'sync-report-section-title';
            title.textContent = section.title;
            sectionEl.appendChild(title);
            for (const line of (section.lines || [])) {
                const row = document.createElement('div');
                row.className = 'sync-report-row';
                const label = document.createElement('span');
                label.textContent = line.label;
                const value = document.createElement('strong');
                value.textContent = String(line.count ?? 0);
                if (line.status) value.className = 'sync-report-' + line.status;
                row.append(label, value);
                sectionEl.appendChild(row);
                if (Array.isArray(line.ids) && line.ids.length) {
                    const idList = document.createElement('div');
                    idList.className = 'sync-report-ids';
                    for (const id of line.ids) {
                        if (!/^\d{17}$/.test(String(id))) continue;
                        const link = document.createElement('a');
                        link.href = 'https://steamcommunity.com/profiles/' + id;
                        link.target = '_blank';
                        link.rel = 'noopener noreferrer';
                        link.textContent = id;
                        idList.appendChild(link);
                    }
                    sectionEl.appendChild(idList);
                }
            }
            container.appendChild(sectionEl);
        }
        if (report.totals) {
            const totals = document.createElement('section');
            totals.className = 'sync-report-section sync-report-totals';
            const title = document.createElement('div');
            title.className = 'sync-report-section-title';
            title.textContent = 'Final totals';
            totals.appendChild(title);
            for (const [labelText, count] of Object.entries(report.totals)) {
                const row = document.createElement('div');
                row.className = 'sync-report-row';
                const label = document.createElement('span');
                label.textContent = labelText;
                const value = document.createElement('strong');
                value.textContent = String(count);
                row.append(label, value);
                totals.appendChild(row);
            }
            container.appendChild(totals);
        }
        if (report.warning) {
            const warning = document.createElement('div');
            warning.className = 'sync-report-warning';
            warning.textContent = report.warning;
            container.appendChild(warning);
        }
    }
    function saveAndRenderSyncReport(report) {
        report.timestamp = Date.now();
        writeStoredValue(SYNC_REPORT_KEY, JSON.stringify(report));
        renderSyncReport(report);
    }
    function restoreSyncReport() {
        try {
            const report = JSON.parse(readStoredValue(SYNC_REPORT_KEY, '') || 'null');
            if (report && Date.now() - Number(report.timestamp || 0) < 86400000) renderSyncReport(report);
        } catch {}
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
        const rootSelectors = [
            '#friends_list',
            '#friends_list_container',
            '#friends_list_wrapper',
            '.friendslist_list',
            '#friend_area'
        ];
        let root = null;
        for (const selector of rootSelectors) {
            const candidate = document.querySelector(selector);
            if (candidate && candidate.querySelector('.friend_block_v2, .friend_block')) {
                root = candidate;
                break;
            }
        }

        // Fail closed rather than treating arbitrary profile links elsewhere
        // on Steam as friends. This protects against false nickname updates
        // and unwanted friend requests.
        if (!root) {
            return { friends: new Map(), complete: false, reason: 'Steam friend-list container was not found.' };
        }

        const friends = new Map();
        const blocks = [...root.querySelectorAll('.friend_block_v2, .friend_block')];
        let invalidBlocks = 0;

        for (const block of blocks) {
            let steamId = String(
                block.getAttribute('data-steamid') ||
                block.querySelector('[data-steamid]')?.getAttribute('data-steamid') ||
                ''
            ).trim();

            if (!/^\d{17}$/.test(steamId)) {
                const links = block.querySelectorAll('a[href*="/profiles/"]');
                for (const link of links) {
                    const rawHref = String(link.getAttribute('href') || '').trim();
                    const match = rawHref.match(
                        /(?:https?:\/\/steamcommunity\.com)?\/profiles\/(\d{17})(?:[/?#]|$)/
                    );
                    if (match) {
                        steamId = match[1];
                        break;
                    }
                }
            }

            if (!/^\d{17}$/.test(steamId)) {
                invalidBlocks++;
                continue;
            }

            friends.set(steamId, block);
        }

        const complete = invalidBlocks === 0 && friends.size === blocks.length;
        return {
            friends,
            complete,
            reason: complete ? '' : `Found ${invalidBlocks} friend entry/entries without a valid SteamID.`,
            blockCount: blocks.length
        };
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

    function getSteamDisplayName(block) {
        if (!block) return '';

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

    async function scanFriends() {
        let bestSnapshot = { friends: new Map(), complete: false, reason: 'Friend list has not loaded.' };
        let stableScans = 0;
        let previousSignature = null;

        for (let attempt = 1; attempt <= AUTO_SCAN_RETRIES; attempt++) {
            if (stopRequested) throw new Error('Sync stopped.');

            const snapshot = getFriendBlocks();
            const signature = [...snapshot.friends.keys()].sort().join('|');

            if (snapshot.friends.size >= bestSnapshot.friends.size) bestSnapshot = snapshot;

            if (snapshot.complete && signature === previousSignature) {
                stableScans++;
            } else {
                stableScans = 0;
            }
            previousSignature = signature;

            // Require a recognized Steam list container, valid IDs for every
            // rendered friend block, and two consecutive identical snapshots.
            // Empty lists are allowed only when the recognized container exists.
            if (snapshot.complete && stableScans >= 1) {
                lastFriendCoverageCheckAt = Date.now();
                return snapshot.friends;
            }

            setStatus(
                'Checking Steam friend list…',
                `Scan ${attempt}/${AUTO_SCAN_RETRIES} — found ${snapshot.friends.size} friend(s)${snapshot.reason ? ' — ' + snapshot.reason : ''}`
            );
            await sleep(AUTO_SCAN_RETRY_DELAY_MS);
        }

        throw new Error(
            'Could not verify a complete, stable Steam friend-list snapshot. No nickname changes or automatic friend requests were made. ' +
            (bestSnapshot.reason || 'Reload the Friends page and try again.')
        );
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
            'STEAM NICKNAME VERIFICATION — API KEY SETUP\\n\\n' +
            'WHY THIS IS NEEDED\\n' +
            'Steam can report a nickname update as successful even when it was not saved. This key lets the script ask Steam for your saved local nickname list so it can verify changes.\\n\\n' +
            'HOW TO GET YOUR KEY\\n' +
            '1. Open https://steamcommunity.com/dev/apikey in a new tab.\\n' +
            '2. Sign in to the same Steam account you use with this script.\\n' +
            '3. If Steam asks you to register, complete its registration.\\n' +
            '4. Copy the 32-character Web API Key shown by Steam.\\n' +
            '5. Return here, paste the key below, and select OK.\\n\\n' +
            'PRIVACY — PLEASE READ\\n' +
            '• The key is saved only in this browser’s Tampermonkey storage.\\n' +
            '• The script sends the key directly to Steam’s official Web API only to retrieve your nickname list.\\n' +
            '• The key is NOT sent to our Discord bot, Railway server, or GitHub.\\n' +
            '• We do not ask for your Steam password, Steam session cookie, or Discord credentials.\\n' +
            '• The key is not needed by the bot and is not shared with other users.\\n\\n' +
            'You can remove the saved key at any time with “Remove Steam API Key” in the script. ' +
            'You need to set it up once for each browser/Tampermonkey installation.\\n\\n' +
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
        setStatus('Steam Web API key saved locally. Testing direct access to Steam…');
        getSteamNicknameList()
            .then(() => setStatus('Steam nickname verification is ready. Your key remains stored locally.'))
            .catch(error => setStatus(error.message || 'Steam nickname verification test failed.'));
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

    function getAccountIdFromSteamId(steamId) {
        try {
            return (BigInt(steamId) - 76561197960265728n).toString();
        } catch {
            return '';
        }
    }

    async function getSteamNicknameList() {
        const apiKey = getSteamApiKey();
        if (!apiKey) throw new Error('Steam nickname verification is not configured. Select “Set Steam API Key” and add your key from https://steamcommunity.com/dev/apikey.');
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://api.steampowered.com/IPlayerService/GetNicknameList/v1/?key=${encodeURIComponent(apiKey)}`,
                timeout: REQUEST_TIMEOUT_MS,
                headers: { Accept: 'application/json' },
                onload: response => {
                    if (response.status < 200 || response.status >= 300) {
                        reject(new Error(`Steam nickname verification request failed (HTTP ${response.status}).`));
                        return;
                    }
                    let payload;
                    try {
                        payload = JSON.parse(String(response.responseText || '{}'));
                    } catch {
                        reject(new Error('Steam nickname verification returned invalid JSON.'));
                        return;
                    }
                    const responseData = payload?.response;
                    const nicknames = responseData?.nicknames ?? payload?.nicknames;
                    if (Array.isArray(nicknames)) {
                        resolve(nicknames);
                        return;
                    }
                    // Steam may omit an empty repeated protobuf field entirely.
                    // An explicit response object with no error therefore means
                    // an empty nickname list, not a malformed response.
                    if (responseData && typeof responseData === 'object' && !Array.isArray(responseData) && !payload?.error) {
                        resolve([]);
                        return;
                    }
                    reject(new Error(payload?.error || 'Steam did not return a readable nickname list. Verification is unavailable.'));
                },
                onerror: () => reject(new Error('Could not contact Steam to verify the nickname list.')),
                ontimeout: () => reject(new Error('Steam nickname verification timed out.'))
            });
        });
    }

    async function verifySteamNickname(steamId, expectedNickname) {
        const expected = trimNickname(expectedNickname);
        const accountId = getAccountIdFromSteamId(steamId);
        if (!accountId) throw new Error(`Could not convert SteamID ${steamId} for nickname verification.`);

        let lastError = null;
        for (let attempt = 1; attempt <= NICKNAME_VERIFY_ATTEMPTS; attempt++) {
            if (stopRequested) throw new Error('Sync stopped.');
            try {
                const nicknames = await getSteamNicknameList();
                const entry = nicknames.find(item =>
                    String(item?.accountid ?? item?.account_id ?? '') === accountId ||
                    String(item?.steamid ?? '') === steamId
                );
                const actual = trimNickname(entry?.nickname || '');
                const matches = expected
                    ? Boolean(entry) && actual === expected
                    : !entry || actual === '';

                if (matches) return;
                lastError = new Error(
                    expected
                        ? `Steam did not save the expected nickname for ${steamId}. Expected "${expected}", but Steam returned "${actual || '(no nickname)'}".`
                        : `Steam did not confirm removal of the local nickname for ${steamId}.`
                );
            } catch (error) {
                lastError = error;
            }
            if (attempt < NICKNAME_VERIFY_ATTEMPTS) await sleep(NICKNAME_VERIFY_DELAY_MS);
        }
        throw lastError || new Error(`Could not verify the nickname update for ${steamId}.`);
    }

    async function setSteamNickname(steamId, nickname) {
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
                    if (response.status < 200 || response.status >= 300) {
                        reject(new Error(`Steam nickname update failed for ${steamId} (HTTP ${response.status}).`));
                        return;
                    }

                    let data;
                    try {
                        data = JSON.parse(String(response.responseText || '{}'));
                    } catch {
                        reject(new Error(`Steam nickname update returned invalid data for ${steamId}.`));
                        return;
                    }

                    if (Number(data?.success) !== 1) {
                        reject(new Error(`Steam nickname update failed for ${steamId}.`));
                        return;
                    }
                    resolve();
                },
                onerror: () => reject(new Error(`Steam nickname update failed for ${steamId}.`)),
                ontimeout: () => reject(new Error(`Steam nickname update timed out for ${steamId}.`))
            });
        });

        // A successful ajaxsetnickname response is not proof that Steam
        // persisted the nickname. Re-fetch Steam's server-side nickname list
        // and compare the exact value (or confirm that the entry was removed).
        await verifySteamNickname(steamId, expectedNickname);
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
        return states
            .map(item => ({
                steamId: getStateSteamId(item),
                nickname: getStateNickname(item),
                role: String(item?.role || '').trim()
            }))
            .filter(item => item.steamId && item.nickname)
            .sort((a, b) => a.steamId.localeCompare(b.steamId))
            .map(item => `${item.steamId}|${item.role}|${item.nickname}`)
            .join('\n');
    }

    async function syncNicknames(force = false) {
        if (syncRunning) return;
        if (!getToken()) { setStatus('No sync token configured.'); return; }
        if (!isFriendsPage()) { setStatus('Open Steam → Friends to run nickname sync.'); return; }
        syncRunning = true;
        stopRequested = false;
        setButtonDisabled(true);

        const roles = {
            Gump: { detected: 0, prefixed: 0, failed: [], missing: [] },
            Recruit: { detected: 0, prefixed: 0, failed: [], missing: [] }
        };
        const cleared = { detected: 0, removed: 0, failed: [], missing: [] };
        const requests = {
            Gump: { sent: [], pending: [], cooldown: [], failed: [] },
            Recruit: { sent: [], pending: [], cooldown: [], failed: [] }
        };

        try {
            setStatus('Loading Discord sync data…');
            const data = await apiRequest('GET', SYNC_API_URL + '/client/all-state');
            if (!getSteamApiKey()) throw new Error('Before syncing, select “Set Steam API Key” and add your key from https://steamcommunity.com/dev/apikey. Steam requires an API key to retrieve the saved nickname list for verification.');
            const currentSteamId = getSteamId();
            if (!currentSteamId || data.steamId !== currentSteamId) throw new Error('This sync token is not for the Steam account currently signed in.');
            if (data.ok !== true || data.complete !== true || !Array.isArray(data.states)) throw new Error('Sync data is incomplete. No nicknames were changed.');
            if (Number(data.memberCount || 0) > 0 && Number(data.fetchedMemberCount || data.memberCount) < Number(data.memberCount)) throw new Error('Discord member data is incomplete. No nicknames were changed.');

            const signature = stateSignature(data.states);
            const previous = String(readStoredValue(LAST_COMPLETED_SIGNATURE_KEY, '') || '');
            const needsCheck = force || signature !== previous.split('\n#coverage:')[0] || Date.now() - lastFriendCoverageCheckAt >= FRIEND_COVERAGE_RECHECK_MS;
            if (!needsCheck) { setStatus('Already synchronized.'); return; }

            const friends = await scanFriends();
            lastFriendCoverageCheckAt = Date.now();
            const coverage = friendCoverageSignature(data.states, friends);
            const stateById = new Map();
            for (const state of data.states) {
                const id = getStateSteamId(state);
                if (id && getStateNickname(state)) stateById.set(id, state);
            }

            const desired = new Map(), clearStates = new Map();
            for (const [id, state] of stateById) {
                if (id === currentSteamId) continue;
                const role = String(state.role || '').trim();
                if (role === 'Gump' || role === 'Recruit') {
                    desired.set(id, state);
                    roles[role].detected++;
                } else {
                    clearStates.set(id, state);
                    cleared.detected++;
                }
            }

            const expected = [
                ...[...desired.entries()].filter(([id]) => friends.has(id)).map(([id, state]) => id + ':' + buildSteamNickname(state, friends.get(id))),
                ...[...clearStates.keys()].filter(id => friends.has(id)).map(id => {
                    const name = getSteamDisplayName(friends.get(id));
                    if (!name) throw new Error('Could not read a Steam display name for one of the friends being cleared.');
                    return id + ':' + name;
                })
            ].sort().join('|');
            const completionSignature = signature + '\n#coverage:' + coverage + '\n#nicknames:' + expected;
            if (!force && completionSignature === previous) { setStatus('Already synchronized.'); return; }

            for (const [id, state] of desired) if (!friends.has(id)) roles[state.role].missing.push(id);
            for (const id of clearStates.keys()) if (!friends.has(id)) cleared.missing.push(id);

            for (const [id, state] of desired) {
                if (friends.has(id)) continue;
                if (stopRequested) throw new Error('Sync stopped.');
                try {
                    const result = await sendSteamFriendRequest(id);
                    if (result === 'sent') requests[state.role].sent.push(id);
                    else if (result === 'pending') requests[state.role].pending.push(id);
                    else if (result === 'throttled') requests[state.role].cooldown.push(id);
                } catch { requests[state.role].failed.push(id); }
                await sleep(500);
            }

            const entries = [...desired.entries()].filter(([id]) => friends.has(id));
            const clearEntries = [...clearStates.entries()].filter(([id]) => friends.has(id));
            let processed = 0;
            const total = entries.length + clearEntries.length;
            for (const [id, state] of entries) {
                if (stopRequested) throw new Error('Sync stopped.');
                processed++;
                setStatus('Syncing role nicknames…', 'Processing ' + processed + ' / ' + total);
                try {
                    await setSteamNickname(id, buildSteamNickname(state, friends.get(id)));
                    roles[state.role].prefixed++;
                } catch { roles[state.role].failed.push(id); }
                await sleep(500);
            }
            for (const [id] of clearEntries) {
                if (stopRequested) throw new Error('Sync stopped.');
                processed++;
                setStatus('Removing old role prefixes…', 'Processing ' + processed + ' / ' + total);
                try {
                    const name = getSteamDisplayName(friends.get(id));
                    if (!name) throw new Error('Could not read a Steam display name.');
                    await setSteamNickname(id, name);
                    cleared.removed++;
                } catch { cleared.failed.push(id); }
                await sleep(500);
            }

            const failed = roles.Gump.failed.length + roles.Recruit.failed.length + cleared.failed.length;
            if (failed === 0) writeStoredValue(LAST_COMPLETED_SIGNATURE_KEY, completionSignature);
            else removeStoredValue(LAST_COMPLETED_SIGNATURE_KEY);

            const sections = [];
            for (const role of ['Gump', 'Recruit']) {
                const r = roles[role], q = requests[role];
                if (!r.detected && !r.missing.length && !r.prefixed && !r.failed.length) continue;
                sections.push({
                    title: role + ' members detected: ' + r.detected,
                    lines: [
                        { label: 'Successfully prefixed with ' + role, count: r.prefixed, status: 'success' },
                        { label: 'Not currently Steam friends', count: r.missing.length, status: r.missing.length ? 'warning' : 'muted', ids: r.missing },
                        { label: 'Friend requests sent', count: q.sent.length, status: 'success', ids: q.sent },
                        { label: 'Requests already pending', count: q.pending.length, status: 'muted', ids: q.pending },
                        { label: 'Requests on cooldown', count: q.cooldown.length, status: 'muted', ids: q.cooldown },
                        { label: 'Friend request failures', count: q.failed.length, status: q.failed.length ? 'danger' : 'muted', ids: q.failed },
                        { label: 'Prefix changes not verified', count: r.failed.length, status: r.failed.length ? 'danger' : 'success', ids: r.failed }
                    ]
                });
            }
            if (cleared.detected) {
                sections.push({
                    title: 'Members no longer holding Gump or Recruit: ' + cleared.detected,
                    lines: [
                        { label: 'Prefixes successfully removed', count: cleared.removed, status: 'success' },
                        { label: 'Not currently Steam friends', count: cleared.missing.length, status: cleared.missing.length ? 'warning' : 'muted', ids: cleared.missing },
                        { label: 'Removals not verified', count: cleared.failed.length, status: cleared.failed.length ? 'danger' : 'success', ids: cleared.failed }
                    ]
                });
            }
            const detected = roles.Gump.detected + roles.Recruit.detected + cleared.detected;
            const verified = roles.Gump.prefixed + roles.Recruit.prefixed + cleared.removed;
            const missing = roles.Gump.missing.length + roles.Recruit.missing.length + cleared.missing.length;
            const requestFailures = requests.Gump.failed.length + requests.Recruit.failed.length;
            saveAndRenderSyncReport({
                title: failed || requestFailures || missing ? 'Nickname Sync Results — Review' : 'Nickname Sync Results — Complete',
                sections: sections,
                totals: {
                    'Members detected': detected,
                    'Nickname changes verified': verified,
                    'Nickname changes not verified': failed,
                    'Members not currently Steam friends': missing
                },
                warning: failed || requestFailures
                    ? 'Some actions could not be confirmed. Failed SteamIDs above link directly to their Steam profiles. Run Sync All Nicknames again after reviewing.'
                    : missing
                        ? 'Members who are not yet Steam friends will receive their role prefix after they accept your friend request. Hidden or unloaded Steam friends may not be included in this scan.'
                        : 'All attempted nickname changes were verified against Steam. Hidden or unloaded Steam friends may not be included in this scan.'
            });
            setStatus(failed || requestFailures ? 'Sync finished with items needing attention.' : 'Sync report ready.',
                verified + ' nickname changes verified; ' + failed + ' not verified; ' + missing + ' members are not currently Steam friends.');
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

        if (!getSteamApiKey()) {
            setStatus('Set your Steam Web API key before removing nicknames so each removal can be verified.');
            return;
        }
        if (!confirm('Remove local nicknames from the friends currently loaded in Steam’s Friends list? This only covers entries Steam has rendered on this page; hidden, paginated, or not-yet-loaded friends may not be included. This is an explicit manual action.')) return;

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
            const failedSteamIds = [];
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
                    failedSteamIds.push(steamId);
                }
                await sleep(500);
            }

            // Invalidate the old signature after any partial clear so the next
            // manual/automatic sync reconciles successful changes as well.
            removeStoredValue(LAST_COMPLETED_SIGNATURE_KEY);

            const clearedCount = friends.size - failed;
            saveAndRenderSyncReport({
                title: failed ? 'Remove All Results — Review' : 'Remove All Results — Complete',
                sections: [{
                    title: 'Steam friends scanned: ' + friends.size,
                    lines: [
                        { label: 'Nicknames successfully removed and verified', count: clearedCount, status: 'success' },
                        { label: 'Removals not verified', count: failed, status: failed ? 'danger' : 'success', ids: failedSteamIds }
                    ]
                }],
                totals: { 'Friends scanned': friends.size, 'Removals verified': clearedCount, 'Removals not verified': failed },
                warning: failed
                    ? 'Some removals could not be confirmed. Failed SteamIDs link directly to their Steam profiles. Run Remove All again after reviewing.'
                    : 'All removals were verified. This only covers friends currently rendered in Steam’s Friends list.'
            });
            removeStoredValue(LAST_COMPLETED_SIGNATURE_KEY);
            setStatus(failed ? 'Remove All finished with items needing attention.' : 'Remove All report ready.',
                clearedCount + ' nickname removals verified; ' + failed + ' not verified.');
        } catch (error) {
            setStatus(error.message || 'Could not remove friend nicknames.');
        } finally {
            syncRunning = false;
            setButtonDisabled(false);
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
        const otherPrefix = getEffectivePrefix(otherRole);
        const proposedPrefix = getEffectivePrefix(role, prefix);

        if (proposedPrefix.toLowerCase() === otherPrefix.toLowerCase()) {
            const warning = 'Gump and Recruit prefixes must be different. Please choose two unique prefixes.';
            setStatus(warning);
            alert(warning);
            return;
        }

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
        writeStoredValue(TOKEN_KEY, value);
        setStatus('Token saved. Testing sync…');
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
        #discord-steam-sync-button{background:#58A864!important;color:#ffffff!important}
        /* Setup/configuration actions: blue */
        #discord-steam-sync-setup,
        #discord-steam-sync-api-key,
        #discord-steam-sync-gump-prefix,
        #discord-steam-sync-recruit-prefix{background:#2878c8!important;color:#ffffff!important}
        /* Destructive actions: red */
        #discord-steam-sync-remove-api-key,
        #discord-steam-sync-clear-friends{background:#c43d3d!important;color:#ffffff!important}
        /* Stop action: yellow */
        #discord-steam-sync-stop{background:#e6b83f!important;color:#222222!important}
        #discord-steam-sync-panel button:disabled{opacity:.5!important;cursor:not-allowed!important}
        #discord-steam-sync-status{margin-top:4px!important;line-height:1.35!important;min-height:38px!important;color:#d7d7d7!important}
        #discord-steam-sync-progress{margin-top:5px!important;color:#8f98a0!important;font-size:12px!important}
        #discord-steam-sync-panel{width:380px!important;max-height:75vh!important;overflow-y:auto!important}
        #discord-steam-sync-report{margin-top:12px!important;padding-top:10px!important;border-top:1px solid #3b4450!important;font-size:12px!important;line-height:1.4!important}
        #discord-steam-sync-report .sync-report-heading{font-size:14px!important;font-weight:700!important;margin-bottom:8px!important;color:#fff!important}
        #discord-steam-sync-report .sync-report-section{padding:7px 0!important;border-top:1px solid #303944!important}
        #discord-steam-sync-report .sync-report-section-title{font-weight:700!important;color:#e6e9ed!important;margin-bottom:5px!important}
        #discord-steam-sync-report .sync-report-row{display:flex!important;justify-content:space-between!important;gap:8px!important;margin:3px 0!important}
        #discord-steam-sync-report .sync-report-row strong{white-space:nowrap!important}
        #discord-steam-sync-report .sync-report-success{color:#70c080!important}
        #discord-steam-sync-report .sync-report-danger{color:#ff7777!important}
        #discord-steam-sync-report .sync-report-warning{color:#e6bd59!important}
        #discord-steam-sync-report .sync-report-muted{color:#aab2bb!important}
        #discord-steam-sync-report .sync-report-ids{display:flex!important;flex-wrap:wrap!important;gap:4px 9px!important;margin:3px 0 6px 8px!important}
        #discord-steam-sync-report .sync-report-ids a{color:#8abfff!important;text-decoration:underline!important}
        #discord-steam-sync-report .sync-report-warning{margin-top:8px!important;padding:7px!important;border-radius:4px!important;background:#493c20!important;color:#f1d58a!important}
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

        restoreSyncReport();

        const hasToken = Boolean(getToken());
        const hasApiKey = Boolean(getSteamApiKey());
        setStatus(
            !hasToken ? 'Sync token required.' :
            !hasApiKey ? 'Steam API key required.' :
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
