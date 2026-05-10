import prompts from 'prompts';

import { LogLevel, LogColors } from './constants.js';
import { loadEnv } from './envLoader.js';
import TF2Engine from './tf2Engine.js';
import ConsoleManager from './cli.js';

await loadEnv();

// Arg parsing
import { parseArgs } from 'node:util';
const options = {
    help: { type: 'boolean', short: 'h'},
    forget: { type: 'boolean', short: 'f'},
    forgetme: { type: 'boolean' },
};
const { values: argVals } = parseArgs({ options });

function displayHelp() {
    console.log(`
Usage: npm run start -- [options]

Options:
    -f, --forget    Clear the login token before running
    -h, --help      Show this help message

Examples:
    npm run start -- --forget
    npm run start -- -h
`
    );
}

function setupListeners(engine) {    
    engine.on('inputRequired', async (data) => {
        const response = await prompts({
            type: 'text',
            name: 'input',
            message: data.message
        });
        
        data.callback(response["input"]);
    });
    
    engine.on('needCredentials', async (data) => {
        const response = await prompts([
            { type: 'text', name: 'username', message: 'Steam Username:' },
            { type: 'password', name: 'password', message: 'Steam Password:' }
        ]);
        if (!response.username || !response.password) {
            console.log("Login cancelled. Exiting...");
            process.exit(0);
        }
        data.callback(response);
    });
}

async function runCli() {

    // Handle flags
    if (argVals.help) { displayHelp(); return; }
    const shouldForget = argVals.forget || argVals.forgetme

    const engine = new TF2Engine();
    const cli = new ConsoleManager(engine);

    // Setup engine
    setupListeners(engine)
    const readyPromise = new Promise(res => engine.once('ready', res));
    
    await engine.start(shouldForget);
    await readyPromise;

    // Start CLI
    console.log("Initialization complete. Starting CLI...");
    await cli.start();
}

runCli().catch(err => {
    console.error(`Fatal Initialization Error: ${err?.message || "Unknown error"}`);
    process.exit(1);
});
