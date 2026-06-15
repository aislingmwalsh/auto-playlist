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
    elements.statusLog.innerHTML += `<div class="${color}">&gt; ${message}</div>`;
    elements.statusLog.scrollTop = elements.statusLog.scrollHeight;
}

// --- SPOTIFY OAUTH MANAGEMENT ---
// Check if URL contains an access token returned from Spotify authentication
function getSpotifyToken() {
    const hash = window.location.hash.substring(1);
    const params = new URLSearchParams(hash);
    const token = params.get('access_token');
    
    if (token) {
        localStorage.setItem('spotify_token', token);
        // Clear hash from URL cleanly
        window.history.replaceState(null, null, window.location.pathname);
        return token;
    }
    return localStorage.getItem('spotify_token');
}

function redirectToSpotifyAuth() {
    const clientId = localStorage.getItem('spotify_client_id');
    const scope = encodeURIComponent('playlist-modify-public playlist-modify-private');
    const authUrl = `https://accounts.spotify.com/authorize?client_id=${clientId}&response_type=token&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${scope}`;
    window.location.href = authUrl;
}

// --- CORE LOGIC ---
elements.generateBtn.onclick = async () => {
    const artist = elements.artistInput.value.trim();
    const setlistKey = localStorage.getItem('setlist_api_key');
    const spotifyToken = getSpotifyToken();

    if (!artist || !setlistKey) {
        alert("Please specify an artist and ensure API configuration keys are saved.");
        return;
    }

    if (!spotifyToken) {
        log("Redirecting to Spotify for login authorization...");
        setTimeout(redirectToSpotifyAuth, 1000);
        return;
    }

    elements.statusLog.innerHTML = ''; // reset log
    log(`Searching for ${artist} on Setlist.fm...`);

    // 1. Fetch from Setlist.fm via public CORS proxy
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
        
        // 2. Resolve Tracks on Spotify & Compile Playlist
        await buildSpotifyPlaylist(playlistName, tracks, artist, spotifyToken);

    } catch (err) {
        log("Failed gathering data. Ensure you have unlocked proxy access.", true);
        console.error(err);
    }
};

async function buildSpotifyPlaylist(name, tracks, artist, token) {
    log("Connecting to Spotify API...");
    
    // Get Spotify User ID
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

    // Search for track URIs
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

    // Create New Playlist
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

    // Push tracks into playlist
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
getSpotifyToken();
