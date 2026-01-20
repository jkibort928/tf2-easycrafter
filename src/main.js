const fs = require('fs');
const path = require('path');
const prompts = require('prompts');
const SteamUser = require('steam-user');
const TeamFortress2 = require('tf2');

// Config
const programName = "TF2-EasyCrafter"
const DATA_DIR = path.join(__dirname, '..', 'data');
const USER_DATA_DIR = path.join(DATA_DIR, 'node-steamuser');
const TOKEN_PATH = path.join(DATA_DIR, 'refresh_token.json');

// Initialization
if (!fs.existsSync(DATA_DIR)) { fs.mkdirSync(DATA_DIR, { recursive: true }); }
let user = new SteamUser({ dataDirectory: USER_DATA_DIR });
let tf2 = new TeamFortress2(user);

// Item schema
const rawItems = require('tf2-static-schema/static/items.json');
// Access items by defIndex
const items = {};
rawItems.forEach(item => { items[item.defindex] = item; });

function setupEventListeners() {

    // --- Pre-logon ---
    user.on('steamGuard', async (domain, callback, lastCodeWrong) => {
        if (lastCodeWrong) {
            console.warn("Last code was incorrect! Please try again.");
        }
        
        const codeOrigin = domain ? `Email (${domain})` : 'Mobile Authenticator';
        const response = await prompts({
            type: 'text',
            name: 'code',
            message: `Enter Steam Guard code from your ${codeOrigin}: `
        });
        
        if (!response.code) {
            console.log("Cancelled.");
            process.exit(0);
        }
        callback(response.code.trim());
    });

    // --- Post-logon ---
    user.on('loggedOn', () => {
        console.log("Logged into Steam! Connecting to TF2 GC...");
        //user.setPersona(SteamUser.EPersonaState.Online); // Set status online to avoid issues
        user.setPersona(SteamUser.EPersonaState.Invisible); // Set status invis while indev
        user.gamesPlayed([440]); // "Start" TF2
    });

    user.on('refreshToken', (refreshToken) => {
        console.log("Refresh token generated, saving.");
        const data = {
            token: refreshToken,
            timestamp: Date.now(),
            account: user.steamID ? user.steamID.getSteamID64() : 'unknown'
        };
        
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(data, null, 4), 'utf8');
    });

    // --- TF2 ---
    tf2.on('connectedToGC', () => {
        console.log("Connected to TF2 Game Coordinator!");
    });
    
    tf2.on('backpackLoaded', () => {
        console.log(`Inventory loaded: ${tf2.backpack.length} items found.`);

        //test
        if (tf2.backpack.length > 0) {
            console.log(tf2.backpack[0]);
            console.log(items[tf2.backpack[0].def_index]);
        }

        // Test
        if (tf2.haveGCSession) {
            const refined = tf2.backpack.filter(item => item.defindex === 5002);
            console.log(`You have ${refined.length} Refined Metal.`);
            if (refined.length > 0) {
                console.log(refined[0]);
            }
        }
    });

    // --- Errors ---
    user.on('error', async (err) => {
        console.error("Steam Login Error:", err.message);
        
        if (err.eresult === SteamUser.EResult.InvalidPassword) {
            console.log("Session invalid. Deleting saved token.");
            if (fs.existsSync(TOKEN_PATH)) fs.unlinkSync(TOKEN_PATH);
            await logon() // Retry login
            
        } else {
            // Fatal?
            process.exit(1);
        }
    });

    user.on('disconnected', (eresult, msg) => {
        console.warn(`Steam connection lost: ${msg} (${eresult}). Reconnecting...`);
    });
}

async function logon() {
    // Try refreshToken
    if (fs.existsSync(TOKEN_PATH)) {
        try {
            const fileContent = fs.readFileSync(TOKEN_PATH, 'utf8');
            const sessionData = JSON.parse(fileContent);

            if (sessionData.token) {
                console.log("Found saved JSON session. Logging in...");
                user.logOn({
                    refreshToken: sessionData.token,
                    machineName: programName
                });
                return;
            }
            
        } catch (err) {
            console.warn("Saved token file was corrupt. Ignoring.");
        }
    }
    
    // No token, prompt username/pass
    const response = await prompts([
        { type: 'text', name: 'username', message: 'Steam Username:' },
        { type: 'password', name: 'password', message: 'Steam Password:' }
    ]);
    if (!response.username || !response.password) {
        console.log("Login cancelled.");
        process.exit(0);
    }
    user.logOn({
        accountName: response.username,
        password: response.password,
        machineName: programName
    });
    
}

async function main() {
   console.log("Initializing...");
   setupEventListeners();
   await logon();
}

main();
