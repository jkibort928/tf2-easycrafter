const SteamUser = require('steam-user');
const TeamFortress2 = require('tf2');

async function main() {
    try {
        console.log("Initializing...");
        let user = new SteamUser();
        let tf2 = new TeamFortress2(user);
        console.log(user, tf2);
        
    } catch (err) {
        console.error("Error:", err);
    }
}

main()
