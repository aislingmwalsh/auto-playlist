// --- CONFIG & DOM ELEMENTS ---
const elements = {
    settingsBtn: document.getElementById('settingsBtn'),
    settingsModal: document.getElementById('settingsModal'),
    closeSettings: document.getElementById('closeSettings'),
    saveSettings: document.getElementById('saveSettings'),
    setlistKeyInput: document.getElementById('setlistKeyInput'),
    spotifyIdInput: document.getElementById('spotifyIdInput'),
    setupAlert: document.getElementById('setupAlert'),
    artistInput: document.getElementById('artistInput'),
    generateBtn: document.getElementById('generateBtn'),
    statusLog: document.getElementById('statusLog')
};

const REDIRECT_URI = window.location.origin + window.location.pathname;

// --- INITIALISE APP & KEYS ---
function loadKeys() {
    elements.setlistKeyInput.value = localStorage.getItem('setlist_api_key') || '';
    elements.spotifyIdInput.value = localStorage.getItem('spotify_client_id') || '';
    
    if (!localStorage.getItem('setlist_api_key') || !localStorage.getItem('spotify_client_id')) {
        elements.setupAlert.classList.remove('hidden');
    } else {
        elements.setupAlert.classList.add('hidden');
    }
}

// Modal visibility toggles
elements.settingsBtn.onclick = () => elements.settingsModal.classList.remove('hidden');
elements.closeSettings.onclick = () => elements.settingsModal.classList.add('hidden');
elements.saveSettings.onclick = () => {
    localStorage.setItem('setlist_api_key', elements.setlistKeyInput.value.trim());
    localStorage.setItem('spotify_client_id', elements.spotifyIdInput.value.trim());
    elements.settingsModal.classList.add('hidden');
    loadKeys();
};

function log(message, isError = false) {
    elements.statusLog.classList.remove('hidden');
    const color = isError ? 'text-red-400' : 'text-zinc-300';
    elements.statusLog.innerHTML += `<div class="${color}">> ${message}</div>`;
    elements.statusLog.scrollTop = elements.statusLog.scrollHeight;
}

// --- PKCE CRYPTO HELPERS ---
function generateRandomString(length) {
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const values = crypto.getRandomValues(new Uint8Array(length));
    return Array.from(values).map((x) => possible[x % possible.length]).join('');
}

async function sha256(plain) {
    const encoder = new TextEncoder();
    const data = encoder.encode(plain);
    return crypto.subtle.digest('SHA-256', data);
}

function base64urlencode(a) {
    return btoa(String.fromCharCode.apply(null, new Uint8Array(a)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// --- SPOTIFY OAUTH (PKCE) MANAGEMENT ---
async function redirectToSpotifyAuth() {
    const clientId = localStorage.getItem('spotify_client_id');
    const codeVerifier = generateRandomString(64);
    localStorage.setItem('spotify_code_verifier', codeVerifier);

    const hashed = await sha256(codeVerifier);
    const codeChallenge = base64urlencode(hashed);

    const scope = 'playlist-modify-public playlist-modify-private';
    const authUrl = new URL("https://accounts.spotify.com/authorize");

    const params = {
        response_type: 'code',
        client_id: clientId,
        scope: scope,
        code_challenge_method: 'S256',
        code_challenge: codeChallenge,
        redirect_uri: REDIRECT_URI,
    };

    authUrl.search = new URLSearchParams(params).toString();
    window.location.href = authUrl.toString();
}

async function handleSpotifyCallback() {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    
    if (!code) return localStorage.getItem('spotify_token');

    log("Exchanging authorization code for access token...");
    const clientId = localStorage.getItem('spotify_client_id');
    const codeVerifier = localStorage.getItem('spotify_code_verifier');

    const payload = {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: clientId,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: REDIRECT_URI,
            code_verifier: codeVerifier,
        }),
    };

    try {
        const res = await fetch('https://accounts.spotify.com/api/token', payload);
        const data = await res.json();
        
        if (data.access_token) {
            localStorage.setItem('spotify_token', data.access_token);
            // Clean up URL parameters cleanly
            window.history.replaceState(null, null, window.location.pathname);
            log("Authentication successful!");
            return data.access_token;
        }
    } catch (err) {
        log("Failed to swap token via PKCE.", true);
        console.error(err);
    }
    return null;
}

// --- CORE GATHER & BUILD LOGIC ---
elements.generateBtn.onclick = async () => {
    const artist = elements.artistInput.value.trim();
    const setlistKey = localStorage.getItem('setlist_api_key');
    const spotifyToken = localStorage.getItem('spotify_token');

    if (!artist || !setlistKey) {
        alert("Please specify an artist and ensure API configuration keys are saved.");
        return;
    }

    if (!spotifyToken) {
        log("Redirecting to Spotify for login authorization...");
        setTimeout(redirectToSpotifyAuth, 1000);
        return;
    }

    elements.statusLog.innerHTML = '';
    log(`Searching for ${artist} on Setlist.fm...`);

    const proxyUrl = "https://cors-anywhere.herokuapp.com/"; 
    const targetUrl = `https://api.setlist.fm/rest/1.0/search/setlists?artistName=${encodeURIComponent(artist)}`;
    
    try {
        const response = await fetch(proxyUrl + targetUrl, {
            headers: {
                "Accept": "application/json",
                "x-api-key": setlistKey
            }
        });

        if (response.status === 403) {
            log("Access Blocked. Please check your Setlist.fm key or unlock temporary demo access at cors-anywhere.herokuapp.com", true);
            return;
        }

        const data = await response.json();
        const mostRecentSetlist = data.setlist[0];
        
        const venue = mostRecentSetlist.venue.name;
        const city = mostRecentSetlist.venue.city.name;
        const playlistName = `${artist} — ${venue}, ${city} (${mostRecentSetlist.eventDate})`;
        
        let tracks = [];
        mostRecentSetlist.sets.set.forEach(s => {
            s.song.forEach(song => tracks.push(song.name));
        });

        log(`Found ${tracks.length} tracks from recent show at ${venue}.`);
        await buildSpotifyPlaylist(playlistName, tracks, artist, spotifyToken);

    } catch (err) {
        log("Failed gathering data. Ensure you have unlocked proxy access.", true);
        console.error(err);
    }
};

async function buildSpotifyPlaylist(name, tracks, artist, token) {
    log("Connecting to Spotify API...");
    
    const userRes = await fetch('https://api.spotify.com/v1/me', {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (userRes.status === 401) {
        log("Spotify access expired. Re-authorising...", true);
        localStorage.removeItem('spotify_token');
        redirectToSpotifyAuth();
        return;
    }
    
    const userData = await userRes.json();
    const userId = userData.id;

    let trackUris = [];
    for (let track of tracks) {
        if (!track) continue;
        const query = encodeURIComponent(`track:${track} artist:${artist}`);
        const searchRes = await fetch(`https://api.spotify.com/v1/search?q=${query}&type=track&limit=1`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const searchData = await searchRes.json();
        
        if (searchData.tracks?.items?.length > 0) {
            trackUris.push(searchData.tracks.items[0].uri);
            log(`Found: ${track}`);
        } else {
            log(`⚠️ Missed: ${track}`, true);
        }
    }

    if (trackUris.length === 0) {
        log("No matching tracks resolved on Spotify. Aborting.", true);
        return;
    }

    log(`Creating playlist: "${name}"...`);
    const playlistRes = await fetch(`https://api.spotify.com/v1/users/${userId}/playlists`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ name: name, description: 'Generated from Setlist.fm', public: true })
    });
    const playlistData = await playlistRes.json();

    await fetch(`https://api.spotify.com/v1/playlists/${playlistData.id}/tracks`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ uris: trackUris })
    });

    log(`🎉 Success! Playlist generated seamlessly inside your Spotify Client.`);
}

// Run on page boot
loadKeys();
handleSpotifyCallback();
