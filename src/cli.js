import readline from 'readline';
import { MetalType, SlotTokens, TFClasses } from './tf2Constants.js';
import { LogLevel, LogColors } from './constants.js';
import Reviewer, { fmtRef } from './reviewer.js';
import PriceClient from './priceClient.js';
import SellClient from './sellClient.js';
import SteamMarketClient from './steamMarketClient.js';
import {
    getTf2Path,
    getHideFriendsState,
    setHideFriends,
    isGameInfoPatched,
    patchGameInfo,
    gameInfoPath,
} from './menuTweaks.js';

// Parses "3", "3,4,5", "3-5", "1,3-5,7" into a sorted unique array of ints in [1, maxN].
// Returns null on any malformed input.
function parseRecList(str, maxN) {
    if (typeof str !== 'string') return null;
    const set = new Set();
    for (const part of str.split(',')) {
        const t = part.trim();
        if (!t) continue;
        if (t.includes('-')) {
            const [aStr, bStr] = t.split('-').map(s => s.trim());
            const a = parseInt(aStr, 10);
            const b = parseInt(bStr, 10);
            if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
            if (a < 1 || b > maxN || a > b) return null;
            for (let i = a; i <= b; i++) set.add(i);
        } else {
            const n = parseInt(t, 10);
            if (!Number.isInteger(n) || n < 1 || n > maxN) return null;
            set.add(n);
        }
    }
    if (set.size === 0) return null;
    return [...set].sort((a, b) => a - b);
}

function parseMetal(target) {
    if (target) {
        target = target.toLowerCase()
    } else {
        return null;
    }

    let targetMetal = null;
    if (target == "scr" || target == "scrap") {
        targetMetal = MetalType.SCRAP;
    } else if (target == "rec" || target == "reclaim" || target == "reclaimed") {
        targetMetal = MetalType.RECLAIMED;
    } else if (target == "ref" || target == "refine" || target == "refined") {
        targetMetal = MetalType.REFINED;
    }
    
    return targetMetal;
}

class ConsoleManager {
    constructor(tf2Engine) {
        this.isActive = false;

        this.engine = tf2Engine;
        this._reviewer = null;
        this._priceClient = null;
        this._sellClient = null;
        this._steamMarket = null;
        this._lastRecs = [];
        this._lastWeaponGroups = null;
        this.engine.on('log', (data) => this._handleLog(data));
        
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: 'TF2-CLI> '
        });

        // Command Registry
        this.commands = {
            // Cmdline-related commands
            'help': {
                description: 'Shows all commands. Provide a command to just show help for that command.\n\t\tUsage: help [command]',
                execute: async (args) => this._handleHelp(args),
                category: 'cmd'
            },
            'quit': {
                description: 'Logs off and closes the bot.',
                execute: async (args) => this._shutdown(args),
                category: 'cmd'
            },

            // Status commands
            'status': {
                description: 'Shows current backpack size and craft item counts.',
                execute: async (args) => this._handleStatus(args),
                category: 'status'
            },
            'junk': {
                description: 'Prints a summary of scrappable items. A scrappable item is a clean item you already have a dupe of.',
                execute: async (args) => this._handleJunkSummary(args),
                category: 'status'
            },
            'review': {
                description: 'Full backpack analysis: categories, dupes, recommended crafts. Pass --refresh to force a price refetch.\n\t\tUsage: review [--refresh]',
                execute: async (args) => this._handleReview(args),
                category: 'status'
            },
            'reco': {
                description: 'List or run recommendations from the last review.\n\t\tUsage: reco | reco do <N> [bptf|steam]\n\t\tSell recs require an explicit marketplace.',
                execute: async (args) => this._handleReco(args),
                category: 'status'
            },
            'weapons': {
                description: 'List weapon stacks (2+ same item) with quality breakdown, then optionally smelt by stack number.\n\t\tUsage: weapons | weapons smelt <N>',
                execute: async (args) => this._handleWeapons(args),
                category: 'craft'
            },

            // Steam-related commands
            'forgetme': {
                description: 'Clears your user login info.',
                execute: async (args) => this._handleForget(args),
                category: 'steam'
            },

            // Craft recipes
            'smelt': {
                description: 'Crafts a specific metal.\n\t\tUsage: smelt <scrap|rec|ref>',
                execute: async (args) => this._handleSmelt(args),
                category: 'craft'
            },
            'combine': {
                description: 'Crafts a specific metal.\n\t\tUsage: combine <scrap|rec|ref>',
                execute: async (args) => this._handleCombine(args),
                category: 'craft'
            },
            'makescrap': {
                description: 'Makes scrap from junk weapons.',
                execute: async (args) => this._handleScrap(args),
                category: 'craft'
            },

            // Main-menu tweaks (custom HUD VPK)
            'menu': {
                description: 'Toggles main-menu tweaks. TF2 must be closed.\n\t\tUsage: menu | menu hidefriends [on|off]',
                execute: async (args) => this._handleMenu(args),
                category: 'menu'
            },

        };

        // Aliases for commands
        this.aliases = {
            'h':            'help',
            'q':            'quit',
            'exit':         'quit',
            's':            'status',
            'inv':          'status',
            'scrap':        'makescrap',
            'j':            'junk',
            'scrappable':   'junk',
            'r':            'review',
            'analyze':      'review',
            'recs':         'reco',
            'recommendations': 'reco',
            'w':            'weapons',
            'stacks':       'weapons',
            'forget':       'forgetme',
        };
    }

    // --- INITIALIZATION ---
    async start() {

        console.log('[CLI] CLI starting...');

        this.rl.on('line', async (input) => {
            const rawText = input.trim();
            if (!rawText) {
                this.rl.prompt();
                return;
            }

            // Parse the input
            const parts = rawText.split(' ');
            let commandName = parts[0].toLowerCase();
            const args = parts.slice(1);

            // Strip the slash if the user typed it (minecraft muscle memory lol)
            if (commandName.startsWith('/')) {
                commandName = commandName.substring(1);
            }

            // Command Execution
            const resolvedName = this.aliases[commandName] || commandName;
            const command = this.commands[resolvedName];
            if (command) {
                try {
                    await command.execute(args);
                } catch (err) {
                    console.error(`Error executing '${commandName}': ${err?.message || "Unknown error"}`);
                }
            } else {
                console.log(`Unknown command: '${commandName}'. Type 'help' for a list of commands.`);
            }

            // Reprompt the user when the command finishes.
            // Delay 100ms to let logging finish before reprompt (avoid overlap).
            setTimeout(() => this.rl.prompt(), 100);
        });

        // Catch Ctrl+C (Interrupt Signal)
        this.rl.on('SIGINT', () => {
            this._shutdown();
        });

        // Catch Ctrl+D (EOF / Close Stream)
        this.rl.on('close', () => {
            this._shutdown();
        });

        
        // Startup Dashboard
        console.log("\n  Welcome!");
        await this.commands['status'].execute();
        console.log("  Type 'help' for a list of commands.\n");

        // Protect user prompts now
        this.isActive = true;
        // Initial prompt
        this.rl.prompt();
    }

    // --- HELPERS ---
    
    _handleLog({ message, level, timestamp }) {
        const time = new Date(timestamp).toLocaleTimeString('en-GB', { hour12: false });
        const displayLevel = level.toUpperCase().padEnd(5);
        const color = LogColors[level] || LogColors.reset;
        const formattedMessage = `${LogColors.DIM}[${time}]:${LogColors.RESET} ${color}${displayLevel}${LogColors.RESET} ${LogColors.DIM}|${LogColors.RESET} ${message}`;

        if (this.isActive) {
            // Clear the current prompt line, print the log, then redraw the prompt
            readline.clearLine(process.stdout, 0);
            readline.cursorTo(process.stdout, 0);
            console.log(formattedMessage);
            this.rl.prompt(true); // true keeps the user's current input intact
        } else {
            console.log(formattedMessage);
        }
    }
    
    _askQuestion(query) {
        return new Promise(resolve => {
            this.rl.question(query, (answer) => {
                // Remove the answer from the history array so it doesn't clutter
                if (this.rl.history && this.rl.history[0] === answer) {
                    this.rl.history.shift();
                }
                resolve(answer);
            });
        });
    }

    // --- COMMAND HANDLERS ---
    
    async _handleHelp(args) {
        if (args.length > 0) {
            // Specific command help
            const target = args[0].replace('/', '');
            const cmd = this.commands[target];
            if (cmd) {
                console.log(`\nCommand: ${target}`);
                console.log(`Description: ${cmd.description}\n`);
            } else {
                console.log(`Command '${target}' not found.`);
            }
        } else {
            // General help list
            console.log('\n ---- Available Commands ----');
            for (const [name, data] of Object.entries(this.commands)) {
                console.log(`  ${name.padEnd(10)} - ${data.description}`);
            }
            console.log('');
        }
    }
    
    async _shutdown() {
        console.log('[CLI] Shutting down...');
        console.log('[CLI] Logging off from Steam...');
        this.engine.logOff();
        console.log('[CLI] CLI terminated.');
        console.log("Goodbye!");
        process.exit(0);
    }

    
    _formatRow(name, count){
        return ` ${name} `.padEnd(29, '.') + ` ${count}`;
    }

    async _handleStatus(args) {
        const items = this.engine.getItemCount();
        const slots = this.engine.getSlots();
        const percent = Math.round((items / slots) * 100);

    
        console.log(' =====================================');
        console.log('   [STATUS] Inventory Overview');
        console.log(' =====================================');
        console.log(`   Backpack Usage : ${items} / ${slots} (${percent}%)`);
        console.log('');
        
        console.log('   --- Crafting Metals ---');
        let foundMetal = false;
        const metalTally = this.engine.crafter.getMetalTally();
        for (const [item, count] of Object.values(metalTally)) {
            if (count > 0) {
                foundMetal = true;
                console.log(this._formatRow(item.displayName, count));
            }
        }
        if (!foundMetal) { console.log(this._formatRow('None', 0)); }
        console.log('');
        
        console.log( this._formatRow("Scrappable Weapons", this.engine.crafter.countJunk()) );
        console.log('');
        
        console.log('   --- Slot Tokens ---');
        let foundSlot = false;
        const slotTokenTally = this.engine.crafter.getSlotTokenTally();
        for (const [item, count] of Object.values(slotTokenTally)) {
            if (count > 0) {
                foundSlot = true;
                console.log(this._formatRow(item.displayName, count));
            }
        }
        if (!foundSlot) { console.log(this._formatRow('None', 0)); }
        console.log('');
        
        console.log('   --- Class Tokens ---');
        let foundClass = false;
        const classTokenTally = this.engine.crafter.getClassTokenTally();
        for (const [item, count] of Object.values(classTokenTally)) {
            if (count > 0) {
                foundClass = true;
                console.log(this._formatRow(item.displayName, count));
            }
        }
        if (!foundClass) { console.log(this._formatRow('None', 0)); }
        console.log('');
        
        console.log(' =====================================');
    }

    async _handleJunkSummary() {
        const junkCounts = this.engine.crafter.getJunkSummary();
        for (const junk of Object.values(junkCounts)) {
            console.log(`  ${this._formatRow(junk.name, junk.count)}`);
        }
    }

    async _handleReview(args = []) {
        if (!this._priceClient) {
            this._priceClient = new PriceClient((msg, lvl) => this.engine.emit('log', { message: msg, level: lvl || LogLevel.INFO, timestamp: Date.now() }));
        }
        if (!this._reviewer) {
            this._reviewer = new Reviewer(this.engine, this._priceClient);
        }

        const refresh = args.includes('--refresh');
        const usePrices = this._priceClient.isConfigured();
        const report = await this._reviewer.analyze({ usePrices, forceRefresh: refresh });
        this._printReport(report);
    }

    _printReport(report) {
        const COL = LogColors;
        const line = (s = '') => console.log(s);
        const header = (title) => {
            line('');
            line(` ${COL.info || ''}== ${title} ==${COL.RESET}`);
        };

        // -- Inventory --
        header('Inventory');
        const usagePct = Math.round((report.inventory.total / report.inventory.capacity) * 100);
        line(this._formatRow('Backpack', `${report.inventory.total} / ${report.inventory.capacity} (${usagePct}%)`));
        for (const [cat, count] of Object.entries(report.inventory.byCategory).sort((a, b) => b[1] - a[1])) {
            line(this._formatRow(`  ${cat}`, count));
        }

        // -- Metal --
        header('Metal');
        line(this._formatRow('Scrap', report.metal.scrap));
        line(this._formatRow('Reclaimed', report.metal.reclaimed));
        line(this._formatRow('Refined', report.metal.refined));
        line(this._formatRow('Total', fmtRef(report.metal.totalRef)));

        // -- Tokens --
        const slotEntries = Object.entries(report.tokens.slot);
        const classEntries = Object.entries(report.tokens.class);
        if (slotEntries.length || classEntries.length) {
            header('Tokens');
            for (const [name, count] of slotEntries) line(this._formatRow(name, count));
            for (const [name, count] of classEntries) line(this._formatRow(name, count));
        }

        // -- Weapon junk --
        header('Weapon Junk');
        const wj = report.weapons;
        line(this._formatRow('Smeltable spares', `${wj.junkPotential.count} (across ${wj.junkPotential.defGroups} groups)`));
        if (wj.junkPotential.protectedCount > 0) {
            line(this._formatRow('Excluded (melee/sniper)', wj.junkPotential.protectedCount));
        }
        if (wj.estimatedYield) {
            line(this._formatRow('Smelt yield', `+${wj.estimatedYield.extraScrap} scrap (+${fmtRef(wj.estimatedYield.metalGainedRef)})`));
            line(this._formatRow('Projected total', fmtRef(wj.estimatedYield.projectedTotalRef)));
        }

        // -- Dupes --
        const printDupe = (d) => {
            const parts = [];
            if (d.spareCount > 0) parts.push(`x${d.spareCount} clean`);
            if (d.modifiedCount > 0) parts.push(`+${d.modifiedCount} modified`);
            const tag = parts.length ? ` (${parts.join(', ')})` : '';
            const protection = d.protectionReason ? `  [${d.protectionReason}, kept]` : '';
            const value = d.spareValueRef != null
                ? `  (${fmtRef(d.spareValueRef)} @ ${fmtRef(d.refPerItem)} ea)`
                : '';
            line(`  ${d.name.padEnd(30)}${tag}${protection}${value}`);

            if (d.modifiedBreakdown?.length) {
                for (const b of d.modifiedBreakdown) {
                    const pricePart = b.refPerItem != null
                        ? `${fmtRef(b.refPerItem)} ea (${fmtRef(b.totalRef)} total)`
                        : 'no price found';
                    line(`      └ ${b.qualityName.padEnd(12)} x${b.count}  ${pricePart}`);
                }
            }
        };
        const printDupes = (label, list, limit = 10) => {
            if (!list.length) return;
            header(`Dupes — ${label}`);
            const shown = list.slice(0, limit);
            for (const d of shown) printDupe(d);
            if (list.length > limit) line(`  ... ${list.length - limit} more`);
        };
        printDupes('Weapons', report.dupes.weapons);
        printDupes('Cosmetics', report.dupes.cosmetics);
        printDupes('Other', report.dupes.other);

        // -- Prices --
        if (report.prices?.enabled) {
            header('Inventory Value (backpack.tf prices)');
            line(this._formatRow('Total ref', fmtRef(report.prices.totalRef)));
            if (report.prices.usdValue != null) {
                line(this._formatRow('Approx USD', `$${report.prices.usdValue.toFixed(2)}`));
            }
            line(this._formatRow('Priced items', `${report.prices.pricedItemCount} / ${report.inventory.total}`));
            const ageMin = Math.round((Date.now() - report.prices.fetchedAt) / 60000);
            line(this._formatRow('Price data age', `${ageMin} min`));

            if (report.prices.topByHolding?.length) {
                line('');
                line('  Top holdings (by total ref):');
                for (const v of report.prices.topByHolding) {
                    line(`    ${v.name.padEnd(30)} x${v.count}  ${fmtRef(v.ref * v.count)} (@ ${fmtRef(v.ref)} ea)`);
                }
            }
            if (report.prices.topByUnit?.length) {
                line('');
                line('  Top single-item value:');
                for (const v of report.prices.topByUnit) {
                    line(`    ${v.name.padEnd(30)} ${fmtRef(v.ref)}`);
                }
            }
        }

        // -- Recommendations --
        header('Recommendations');
        if (!report.recommendations.length) {
            this._lastRecs = [];
            line('  Nothing actionable. Looking good.');
        } else {
            const order = { high: 0, medium: 1, info: 2 };
            const sorted = [...report.recommendations].sort((a, b) => order[a.priority] - order[b.priority]);
            this._lastRecs = sorted; // store ordered list so `reco do N` matches print order
            sorted.forEach((rec, idx) => {
                const num = `[${idx + 1}]`.padStart(4);
                const tag = `[${rec.priority.toUpperCase()}]`.padEnd(9);
                const kind = rec.executable ? '(auto)' : '(manual)';
                line(`  ${num} ${tag} ${rec.summary}  ${kind}`);
                if (rec.detail) line(`              ${rec.detail}`);
            });
            line('');
            line('  Run `reco do <N>` for craft recs.');
            line('  Run `reco do <N> bptf` (or `steam`) for sell recs — marketplace required.');
        }
        line('');
    }

    async _handleReco(args = []) {
        if (!this._lastRecs.length) {
            console.log("No recommendations cached. Run 'review' first.");
            return;
        }

        // No args: re-list
        if (args.length === 0) {
            const order = { high: 0, medium: 1, info: 2 };
            console.log('');
            this._lastRecs.forEach((rec, idx) => {
                const num = `[${idx + 1}]`.padStart(4);
                const tag = `[${rec.priority.toUpperCase()}]`.padEnd(9);
                const kind = rec.executable ? '(auto)' : '(manual)';
                console.log(`  ${num} ${tag} ${rec.summary}  ${kind}`);
                if (rec.detail) console.log(`              ${rec.detail}`);
            });
            console.log('');
            return;
        }

        // `reco do <N|list|range> [bptf|steam]` — accepts e.g. 3, 3,4,5, 3-5, 1,3-5,7
        if (args[0]?.toLowerCase() === 'do' && args[1]) {
            const numbers = parseRecList(args[1], this._lastRecs.length);
            if (!numbers || numbers.length === 0) {
                console.log(`Invalid selection '${args[1]}'. Examples: 'reco do 3', 'reco do 3,4,5', 'reco do 3-5,7'.`);
                return;
            }

            const items = numbers.map(n => ({ n, rec: this._lastRecs[n - 1] }));
            const skipped = items.filter(({ rec }) => !rec.executable);
            const runnable = items.filter(({ rec }) => rec.executable);

            if (skipped.length) {
                console.log(`Skipping ${skipped.length} manual rec(s): ${skipped.map(s => `[${s.n}]`).join(', ')}`);
            }
            if (runnable.length === 0) {
                console.log('No auto-runnable recs in selection.');
                return;
            }

            const sells = runnable.filter(({ rec }) => rec.executable.kind === 'sell');
            let marketplace = null;
            if (sells.length > 0) {
                const arg = args[2]?.toLowerCase();
                if (!arg) {
                    console.log(`Selection includes ${sells.length} sell rec(s) — pick a marketplace:`);
                    console.log(`  reco do ${args[1]} bptf   → backpack.tf classifieds (refined metal, no fee)`);
                    console.log(`  reco do ${args[1]} steam  → Steam Market (USD, ~15% fee, Steam Wallet only)`);
                    return;
                }
                if (!['bptf', 'steam'].includes(arg)) {
                    console.log(`Unknown marketplace '${arg}'. Use 'bptf' or 'steam'.`);
                    return;
                }
                marketplace = arg;
            } else if (args[2]) {
                console.log(`No sell recs in selection — drop the '${args[2]}' argument.`);
                return;
            }

            // Batch summary + single confirm
            const isBatch = runnable.length > 1;
            if (isBatch) {
                console.log('');
                console.log(`Will execute ${runnable.length} recommendation(s):`);
                for (const { n, rec } of runnable) {
                    const tag = rec.executable.kind === 'sell' ? `[${marketplace}]` : `[${rec.executable.kind}]`;
                    console.log(`  [${n}] ${tag.padEnd(12)} ${rec.summary}`);
                }
                console.log('');
                const ans = await this._askQuestion(`Proceed with all ${runnable.length} action(s)? (y/N): `);
                if (ans.trim().toLowerCase() !== 'y') {
                    console.log('Cancelled.');
                    return;
                }
            }

            // Reset per-batch state so sub-handlers can dedupe inventory refresh, etc.
            this._batchState = { firstRefreshDone: false };

            let completed = 0;
            for (const { n, rec } of runnable) {
                console.log('');
                console.log(`>> [${n}] ${rec.summary}`);
                try {
                    await this._executeRec(rec, { marketplace, skipConfirm: isBatch });
                    completed++;
                } catch (err) {
                    console.log(`  Error on [${n}]: ${err?.message || err}`);
                    if (runnable.length > 1) {
                        const cont = await this._askQuestion('Continue with remaining? (y/N): ');
                        if (cont.trim().toLowerCase() !== 'y') break;
                    }
                }
            }
            this._batchState = null;

            console.log('');
            console.log(`Completed ${completed} / ${runnable.length}.`);
            console.log('');
            console.log('Refreshing review...');
            await this._handleReview([]);
            return;
        }

        console.log("Usage: reco | reco do <N|list|range> [bptf|steam]");
    }

    async _executeRec(rec, options = {}) {
        const exec = rec.executable;
        if (!exec) return;

        if (exec.kind === 'makescrap') {
            const pairs = exec.pairs;
            if (!options.skipConfirm) {
                const ans = await this._askQuestion(`Smelt ${pairs} weapon pair(s) into ${pairs} scrap? (y/N): `);
                if (ans.trim().toLowerCase() !== 'y') {
                    console.log('Cancelled.');
                    return;
                }
            }
            for (let i = 0; i < pairs; i++) {
                const ok = await this.engine.crafter.makeScrap(null);
                if (!ok) {
                    console.log(`Stopped after ${i} pair(s).`);
                    return;
                }
            }
            console.log(`Smelted ${pairs} pair(s).`);
            return;
        }

        if (exec.kind === 'combineMetal') {
            const metalType = MetalType[exec.metalName];
            if (!metalType) {
                console.log(`Unknown metal name: ${exec.metalName}`);
                return;
            }
            const batches = exec.batches;
            if (!options.skipConfirm) {
                const ans = await this._askQuestion(`Combine ${batches} batch(es) of ${metalType.fullName}? (y/N): `);
                if (ans.trim().toLowerCase() !== 'y') {
                    console.log('Cancelled.');
                    return;
                }
            }
            for (let i = 0; i < batches; i++) {
                const ok = await this.engine.crafter.combineMetal(metalType);
                if (!ok) {
                    console.log(`Stopped after ${i} batch(es).`);
                    return;
                }
            }
            console.log(`Combined ${batches} batch(es).`);
            return;
        }

        if (exec.kind === 'sell') {
            if (options.marketplace === 'steam') {
                await this._executeSellSteam(exec, options);
            } else {
                await this._executeSell(exec, options);
            }
            return;
        }

        console.log(`Don't know how to execute kind '${exec.kind}'.`);
    }

    async _handleWeapons(args = []) {
        const sub = (args[0] || 'list').toLowerCase();
        if (sub === 'list' || sub === 'ls') {
            await this._listWeaponStacks();
            return;
        }
        if (sub === 'smelt') {
            await this._smeltWeaponStack(args[1]);
            return;
        }
        console.log("Usage: weapons | weapons smelt <N>");
    }

    async _ensureReviewer() {
        if (!this._priceClient) {
            this._priceClient = new PriceClient((msg, lvl) =>
                this.engine.emit('log', { message: msg, level: lvl || LogLevel.INFO, timestamp: Date.now() })
            );
        }
        if (!this._reviewer) {
            this._reviewer = new Reviewer(this.engine, this._priceClient);
        }
    }

    async _listWeaponStacks() {
        await this._ensureReviewer();
        const usePrices = this._priceClient.isConfigured();
        const report = await this._reviewer.analyze({ usePrices });
        const groups = [...report.dupes.weapons].sort((a, b) =>
            (b.totalCount - a.totalCount) ||
            ((b.modifiedTotalRef || 0) - (a.modifiedTotalRef || 0))
        );

        if (!groups.length) {
            console.log('No weapon stacks (2+ same item) found.');
            return;
        }

        console.log('');
        console.log('  Weapon stacks — pick one to smelt with `weapons smelt <N>`:');
        console.log('');

        groups.forEach((g, idx) => {
            const sheet = this.engine.itemSheet[g.defIndex] || {};
            const usedBy = sheet.used_by_classes ? sheet.used_by_classes.join('/') : 'all-class';
            const slot = sheet.item_slot || '?';
            const protection = g.protectionReason ? `  [${g.protectionReason}]` : '';
            const num = `[${idx + 1}]`.padStart(4);
            console.log(`  ${num} ${g.name.padEnd(32)}  ${usedBy.padEnd(18)} ${slot.padEnd(9)}${protection}  total=${g.totalCount}`);

            if (g.cleanCount > 0) {
                const priceStr = g.refPerItem != null ? ` @ ${fmtRef(g.refPerItem)} ea` : '';
                console.log(`        clean (Unique) x${g.cleanCount}${priceStr}`);
            }
            if (g.modifiedBreakdown?.length) {
                for (const b of g.modifiedBreakdown) {
                    const priceStr = b.refPerItem != null
                        ? `@ ${fmtRef(b.refPerItem)} ea — smelting destroys ~${fmtRef(b.totalRef)}`
                        : '(no price)';
                    console.log(`        ${b.qualityName.padEnd(12)} x${b.count}  ${priceStr}`);
                }
            }
        });

        // Cache for `weapons smelt <N>`
        this._lastWeaponGroups = groups;
        console.log('');
    }

    async _smeltWeaponStack(nStr) {
        if (!this._lastWeaponGroups || !this._lastWeaponGroups.length) {
            console.log("Run `weapons` first to see the list.");
            return;
        }
        const n = parseInt(nStr, 10);
        if (!Number.isInteger(n) || n < 1 || n > this._lastWeaponGroups.length) {
            console.log(`Invalid stack number. Pick 1..${this._lastWeaponGroups.length}.`);
            return;
        }
        const g = this._lastWeaponGroups[n - 1];

        // Pull live items from the backpack to avoid stale references
        const liveItems = this.engine.tf2.backpack
            .filter(it => it.def_index === g.defIndex)
            .filter(it => !(it.equipped_state && it.equipped_state.length > 0));

        if (liveItems.length < 2) {
            console.log(`Only ${liveItems.length} non-equipped ${g.name} in backpack — need 2 to smelt.`);
            return;
        }

        const consumed = liveItems.length - (liveItems.length % 2);
        const pairs = consumed / 2;
        const remaining = liveItems.length - consumed;

        // Prefer to consume modified items first (most likely cause of value loss is modified
        // items; the user is consciously choosing this group, so let them see what gets used)
        // Sort: keep clean Uniques to the END, so they're consumed last if odd count.
        liveItems.sort((a, b) => {
            const aMod = a.quality !== 6 || (a.attribute && a.attribute.length > 0) ? 0 : 1;
            const bMod = b.quality !== 6 || (b.attribute && b.attribute.length > 0) ? 0 : 1;
            return aMod - bMod;
        });

        const valueLoss = g.modifiedTotalRef || 0;

        console.log('');
        console.log(`  Stack: ${g.name}`);
        console.log(`  Smelt: ${consumed} weapons → ${pairs} scrap (+${fmtRef(pairs / 9)})`);
        if (remaining > 0) console.log(`  Leftover: ${remaining} (odd count)`);
        if (valueLoss > 0) {
            console.log(`  ⚠  Modified items in stack are worth ~${fmtRef(valueLoss)} on backpack.tf — smelting destroys this value.`);
            console.log(`     Consider \`reco\` to sell them instead.`);
        }
        console.log('');
        const ans = await this._askQuestion('Proceed? (y/N): ');
        if (ans.trim().toLowerCase() !== 'y') {
            console.log('Cancelled.');
            return;
        }

        let smelted = 0;
        for (let i = 0; i + 1 < liveItems.length; i += 2) {
            const ok = await this.engine.crafter.smeltPair(liveItems[i], liveItems[i + 1]);
            if (!ok) {
                console.log(`Smelt failed at pair ${smelted + 1}/${pairs}. Aborting remaining pairs.`);
                break;
            }
            smelted++;
        }
        console.log(`Smelted ${smelted} pair(s).`);
        this._lastWeaponGroups = null; // backpack changed; force re-list next time
    }

    async _executeSellSteam(exec, options = {}) {
        if (!this._steamMarket) {
            this._steamMarket = new SteamMarketClient(this.engine.user, (msg, lvl) =>
                this.engine.emit('log', { message: msg, level: lvl || LogLevel.INFO, timestamp: Date.now() })
            );
        }
        if (!this._priceClient || !this._priceClient.isConfigured()) {
            console.log('Steam Market listing needs backpack.tf prices for ref→USD conversion. Set BPTF_API_KEY in .env and run `review --refresh`.');
            return;
        }

        // Establish web session up front so failures surface before user confirms.
        const sessionOk = await this._steamMarket.ensureWebSession();
        if (!sessionOk) {
            console.log('Could not get a Steam web session. Try restarting the CLI.');
            return;
        }

        const rate = await this._steamMarket.getRefToUsdRate(this._priceClient);
        if (!rate) {
            console.log('Could not compute ref→USD rate. Run `review --refresh` then retry.');
            return;
        }

        // Compute the gross (buyer-pays) price per item in USD, then derive seller-receive.
        // Steam fee math: seller receives ≈ buyer pays × 0.87 (10% Steam + 5% game, with rounding).
        const buyerUsd = exec.medianRef * rate.usdPerRef;
        const sellerReceiveCents = Math.max(1, Math.round(buyerUsd * 100 * 0.87));
        const sellerReceiveUsd = sellerReceiveCents / 100;

        // Re-pick clean Unique items from live backpack
        const matches = this.engine.tf2.backpack.filter(it =>
            it.def_index === exec.defIndex &&
            it.quality === 6 &&
            !it.custom_name && !it.custom_desc &&
            !(it.attribute && it.attribute.length > 0) &&
            !(it.equipped_state && it.equipped_state.length > 0)
        );
        if (matches.length < 2) {
            console.log(`Only found ${matches.length} clean ${exec.name} — need at least 2 (1 to keep). Skipping.`);
            return;
        }
        const toList = matches.slice(0, exec.spareCount);

        console.log('');
        console.log(`  Listing ${toList.length}× ${exec.name} on Steam Market`);
        console.log(`  Buyer pays:  $${buyerUsd.toFixed(2)} ea  (median ${exec.medianRef.toFixed(2)} ref @ $${rate.usdPerRef.toFixed(4)}/ref)`);
        console.log(`  You receive: $${sellerReceiveUsd.toFixed(2)} ea  (Steam fee ~13%)`);
        console.log(`  Total receive: $${(sellerReceiveUsd * toList.length).toFixed(2)}`);
        console.log(`  ⚠ Each listing must be confirmed in your Steam mobile app.`);
        console.log(`  ⚠ Funds go to Steam Wallet only — not cash.`);
        console.log('');
        if (!options.skipConfirm) {
            const ans = await this._askQuestion(`Confirm posting ${toList.length} Steam Market listing(s)? (y/N): `);
            if (ans.trim().toLowerCase() !== 'y') {
                console.log('Cancelled.');
                return;
            }
        }

        let successes = 0;
        let needsConfirm = 0;
        let firstErrorBody = null;
        for (let i = 0; i < toList.length; i++) {
            const item = toList[i];
            const result = await this._steamMarket.listItem({
                assetId: item.id,
                priceCents: sellerReceiveCents,
            });
            if (result.ok) {
                successes++;
                if (result.requiresConfirmation) needsConfirm++;
            } else {
                if (!firstErrorBody) firstErrorBody = result;
                const msg = result.body?.message || result.error || `status=${result.status}`;
                console.log(`  Failed listing item ${item.id}: ${msg}`);
            }
            // Steam Market is touchy about rapid-fire POSTs; small delay
            await new Promise(r => setTimeout(r, 600));
        }

        console.log('');
        console.log(`Listed ${successes} / ${toList.length}.`);
        if (needsConfirm > 0) {
            console.log(`${needsConfirm} listing(s) await confirmation in your Steam mobile app — open it and tap Confirm.`);
        }
        if (successes === 0 && firstErrorBody) {
            console.log('No listings posted. Common causes:');
            console.log('  - Steam Mobile Authenticator not enabled (Steam Market listings require it)');
            console.log('  - Item is on trade hold (recent trade locks listings for 7 days)');
            console.log('  - Inventory privacy set to Private/Friends');
            if (firstErrorBody.body?.message) console.log(`  - Steam said: ${firstErrorBody.body.message}`);
        }
    }

    async _executeSell(exec, options = {}) {
        if (!this._sellClient) {
            this._sellClient = new SellClient((msg, lvl) =>
                this.engine.emit('log', { message: msg, level: lvl || LogLevel.INFO, timestamp: Date.now() })
            );
        }
        if (!this._sellClient.isConfigured()) {
            console.log('BPTF_USER_TOKEN is not set in .env. Cannot list automatically.');
            return;
        }

        // Re-pick items from the live backpack rather than the stale dupe record.
        const matches = this.engine.tf2.backpack.filter(it =>
            it.def_index === exec.defIndex &&
            it.quality === 6 && // Unique
            !it.custom_name && !it.custom_desc &&
            !(it.attribute && it.attribute.length > 0) &&
            !(it.equipped_state && it.equipped_state.length > 0) // don't list equipped
        );

        if (matches.length < 2) {
            console.log(`Only found ${matches.length} clean ${exec.name} in backpack — need at least 2 (1 to keep). Skipping.`);
            return;
        }

        const toList = matches.slice(0, exec.spareCount); // keep the rest
        const totalRef = exec.sellPrice * toList.length;

        console.log('');
        console.log(`  Listing ${toList.length}× ${exec.name}`);
        console.log(`  Price: ${fmtRef(exec.sellPrice)} each (median ${fmtRef(exec.medianRef)} − 5%)`);
        console.log(`  Total: ${fmtRef(totalRef)}`);
        console.log('');
        if (!options.skipConfirm) {
            const ans = await this._askQuestion(`Confirm posting ${toList.length} sell listing(s) on backpack.tf? (y/N): `);
            if (ans.trim().toLowerCase() !== 'y') {
                console.log('Cancelled.');
                return;
            }
        }

        const pulsed = await this._sellClient.pulseAgent();
        if (!pulsed) {
            console.log('Agent pulse failed — listings may not stay published. Continue anyway? (y/N)');
            const cont = await this._askQuestion('> ');
            if (cont.trim().toLowerCase() !== 'y') return;
        }

        // Make backpack.tf refresh its cached copy of our inventory before listing.
        // In batch mode, only do this once per batch — subsequent recs reuse the warm index.
        const steamid = this.engine.user?.steamID?.getSteamID64?.();
        const alreadyRefreshed = !!this._batchState?.firstRefreshDone;
        if (steamid && !alreadyRefreshed) {
            await this._sellClient.refreshInventory(steamid);
            console.log('Waiting for backpack.tf to re-index inventory (up to 30s)...');
            for (let i = 0; i < 6; i++) {
                await new Promise(r => setTimeout(r, 5000));
                const s = await this._sellClient.getInventoryStatus(steamid);
                if (s) {
                    if (s.refresh_status === 1 || s.current === true || s.success === 1) break;
                }
            }
            if (this._batchState) this._batchState.firstRefreshDone = true;
        }

        let successes = 0;
        let firstErrorBody = null;
        for (let i = 0; i < toList.length; i++) {
            const item = toList[i];
            const result = await this._sellClient.createListing({
                itemId: item.id,
                refPrice: exec.sellPrice,
                details: '',
            });
            if (result.ok) {
                successes++;
            } else {
                if (!firstErrorBody) firstErrorBody = result;
                console.log(`  Failed to list item ${item.id}: status=${result.status} ${result.error || ''}`);
                if (result.body) console.log(`    Body: ${String(result.body).slice(0, 300)}`);
            }
        }

        console.log('');
        console.log(`Listed ${successes} / ${toList.length} successfully.`);
        if (successes === 0 && firstErrorBody) {
            const body = String(firstErrorBody.body || '');
            console.log('No listings posted.');
            if (body.includes('could not be resolved') || body.includes('internalError')) {
                console.log('  → backpack.tf still doesn\'t see these items in their cache.');
                console.log('  → Wait 30-60s and retry, or open https://backpack.tf/inventory/' + (steamid || '<steamid>') + ' to force a manual refresh.');
            } else {
                console.log('  Other common causes: token expired, wrong request shape, item already listed.');
            }
        }
    }

    async _handleForget() {
        await this.engine.clearRefreshToken();
    }

    async _handleSmelt(args) {
        if (args.length === 0) {
            console.log("Error: You must specify a metal type. Example: smelt rec");
            return;
        }

        const targetMetal = parseMetal(args[0]);
        if (!targetMetal) {
            console.log("Error: You must specify a valid metal type. Example: smelt ref");
            return;
        }
        
        console.log(`[Crafting] Attempting to smelt ${targetMetal.fullName}...`);
        const res = await this.engine.crafter.smeltMetalDown(targetMetal);
        return res; // idk
    }
    
    async _handleCombine(args) {
        if (args.length === 0) {
            console.log("Error: You must specify a metal type. Example: smelt refined");
            return;
        }

        const targetMetal = parseMetal(args[0]);
        if (!targetMetal) {
            console.log("Error: You must specify a valid metal type. Example: smelt scrap");
            return;
        }
        
        console.log(`[Crafting] Attempting to combine ${targetMetal.fullName}...`);
        const res = await this.engine.crafter.combineMetal(targetMetal);
        return res; // idk
    }

    async _handleMenu(args) {
        const tf2Path = getTf2Path();
        const sub = (args[0] || '').toLowerCase();

        if (!sub) {
            // Status of all menu tweaks
            const [hideState, patched] = await Promise.all([
                getHideFriendsState(tf2Path),
                isGameInfoPatched(tf2Path).catch(() => null),
            ]);
            console.log('');
            console.log(`  TF2 path        : ${tf2Path}`);
            console.log(`  hidefriends     : ${hideState}`);
            console.log(`  gameinfo +vgui  : ${patched === null ? 'unknown (gameinfo.txt unreadable)' : patched ? 'yes' : 'no — required for /custom/ HUD overrides'}`);
            console.log('');
            console.log("  Subcommands: menu hidefriends [on|off]");
            console.log('');
            return;
        }

        if (sub === 'hidefriends') {
            const action = (args[1] || '').toLowerCase();
            if (!action) {
                const state = await getHideFriendsState(tf2Path);
                console.log(`hidefriends: ${state}`);
                return;
            }
            if (action !== 'on' && action !== 'off') {
                console.log("Usage: menu hidefriends [on|off]");
                return;
            }

            // Verify gameinfo.txt is patched, prompt to fix if not
            let patched;
            try {
                patched = await isGameInfoPatched(tf2Path);
            } catch (err) {
                console.log(`Could not read ${gameInfoPath(tf2Path)}: ${err.message}`);
                return;
            }
            if (!patched) {
                console.log(`gameinfo.txt is missing the +vgui tag on tf/custom/*.`);
                console.log(`Without it, the friends-list override won't be loaded by TF2's main menu.`);
                const ans = await this._askQuestion(`Patch ${gameInfoPath(tf2Path)} now? (y/N): `);
                if (ans.trim().toLowerCase() !== 'y') {
                    console.log('Skipped patch. Toggle aborted.');
                    return;
                }
                try {
                    const res = await patchGameInfo(tf2Path);
                    if (res.changed) {
                        console.log(`Patched: '${res.oldTags}' -> '${res.newTags}'`);
                    } else {
                        console.log('Already patched.');
                    }
                } catch (err) {
                    console.log(`Patch failed: ${err.message}`);
                    return;
                }
            }

            try {
                const res = await setHideFriends(tf2Path, action === 'on');
                if (res.changed) {
                    console.log(`hidefriends -> ${res.state}`);
                } else {
                    console.log(`hidefriends already ${res.state}.`);
                }
                console.log('Restart TF2 fully for the change to take effect.');
            } catch (err) {
                if (err?.code === 'EBUSY' || err?.code === 'EPERM') {
                    console.log(`File is locked. Close TF2 and try again.`);
                } else {
                    console.log(err.message);
                }
            }
            return;
        }

        console.log(`Unknown menu subcommand: '${sub}'. Try: menu hidefriends [on|off]`);
    }

    async _handleScrap(args) {
        // TODO: -y option to bypass prompt
        const confirmCb = async () => {
            const answer = await this._askQuestion("Are you sure you want to smelt these? (y/N): ");
            return answer.trim().toLowerCase() === 'y';
        };

        await this.engine.crafter.makeScrap(confirmCb);
    }
    
}

export default ConsoleManager;
