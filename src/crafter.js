import { LogLevel }  from './constants.js';

import {
    ProtectedWeapons,
    
    ItemQuality,
    ItemOrigin,
    UntradeableOrigins,
    UncraftableOrigins,
    ItemCraftType,
    ItemEquipSlot,
    
    MetalType,
    SlotTokens,
    
    TFClasses,
} from './tf2Constants.js';

// 10 seconds
const TIMEOUT_MS = 10000

const DefaultJunkConfig = {
    keepCleanSpare: true, // Don't junk last clean item
    useEquipped: false, // Don't junk equipped items
    excludeSlots: [ItemEquipSlot.MELEE], // Don't junk melees (used to craft Conscientious Objector)
    excludeClasses: [TFClasses.SNIPER]   // Don't junk Sniper items
};

export { DefaultJunkConfig };

class Crafter {
    constructor(tf2Instance, itemSheet, logFunction) {
        this.tf2 = tf2Instance;
        this.itemSheet = itemSheet;
        this._log = logFunction;
    }

    // --- Accessor Methods ---

    getMetalTally() {
        return this._getCountsFor(Object.values(MetalType));
    }

    getSlotTokenTally() {
        return this._getCountsFor(Object.values(SlotTokens), this.tf2.backpack);
    }

    getClassTokenTally() {
        const classTokens = Object.values(TFClasses).map((cls) => cls.token);
        return this._getCountsFor(classTokens, this.tf2.backpack); 
    }

    // Counts "scrappable" items
    countJunk() {
        return this._getJunkItems().length
    }

    getJunkSummary() {
        const itemPool = this._getJunkItems();
        const summary = {}
        for (const item of itemPool) {
            if (!summary[item.def_index]) {
                summary[item.def_index] = {name: this.itemSheet[item.def_index]["item_name"], count: 1};
            } else {
                summary[item.def_index].count += 1;
            }
        }

        return summary;
    }

    // --- Crafting Methods ---
    
    // ------ METAL ------

    // Ensures existence of certain metal only by smelting larger metal.
    // Returns false if unable to ensure.
    async ensureMetalDown(metalType) {
        this._log(`Ensuring ${metalType.name}...`);
        if (this._getAll(metalType.def).length > 0) {
            this._log(`${metalType.fullName} found in inventory!`);
            return true;
        }

        if (metalType.next == null) {
            this._log(`Missing ${metalType.name}. Cannot smelt larger metal.`, LogLevel.WARN);
            return false;
        } else {
            this._log(`Missing ${metalType.name}. Attempting to smelt larger metal...`);
        }
        
        const preSatisfied = await this.ensureMetalDown(metalType.next)
        if (!preSatisfied) {
            return false
        }
        
        this._log(`Smelting 1 ${metalType.next.name} into 3 ${metalType.name}...`);
        const success = await this.smeltMetalDown(metalType.next);
        if (success) {
            this._log(`${metalType.fullName} obtained!`);
        } else {
            this._log(`Failed to obtain ${metalType.fullName}.`, LogLevel.WARN);
        }
        return success;
    }

    async smeltMetalDown(metalType) {
        if (metalType.prev == null) {
            this._log("Attempted to smelt down unsmeltable metal! Aborting...", LogLevel.WARN);
            return false;
        }

        const myMetal = this._getAll(metalType.def)
        if (myMetal.length < 1) {
            this._log(`No valid ${metalType.name} to smelt! Aborting...`, LogLevel.WARN);
            return false;
        }
        const itemsToSmelt = [myMetal[0].id];

        this._log(`Sending craft request to smelt ${metalType.name}...`);
        this.tf2.craft(itemsToSmelt);
        const success = await this._waitForCraft();
        if (!success) {
            this._log("Smelting craft failed!", LogLevel.WARN);
            return false;
        }
        this._log("Smelting craft Completed!");
        return true;
    }

    // Craft specified metal into next highest metal
    async combineMetal(metalType) {
        if (metalType.next == null) {
            this._log(`Cannot create larger metal from 3 ${metalType.name}! Aborting...`, LogLevel.WARN);
            return false;
        }
        
        this._log(`Attempting to combine 3 ${metalType.name} into 1 ${metalType.next.name}...`);
        
        const myMetal = this._getAll(metalType.def);
        if (myMetal.length < 3) {
            this._log(`Insufficient ${metalType.fullName} (have ${myMetal.length}, need 3)! Aborting...`, LogLevel.WARN);
            return false;
        }
        const itemsToSmelt = myMetal.slice(0, 3).map(metal => metal.id);
                
        this._log(`Sending craft request to combine ${metalType.name}...`);
        this.tf2.craft(itemsToSmelt);
        const success = await this._waitForCraft();
        if (!success) {
            this._log("Craft failed!", LogLevel.WARN);
            return false;
        }
        this._log("Craft Completed!");
        return true;
    }

    // Smelt two specific weapons into 1 scrap. Bypasses the junk-config filter so the
    // user can deliberately consume Strange/Vintage/melee/etc. instances that auto-junking
    // protects. Still validates craftability and same-class requirement (the GC enforces both).
    async smeltPair(item1, item2) {
        if (!item1 || !item2) {
            this._log("smeltPair: both items required.", LogLevel.WARN);
            return false;
        }
        if (item1.id === item2.id) {
            this._log("smeltPair: cannot smelt the same item twice.", LogLevel.WARN);
            return false;
        }
        if (!this._itemIsCraftable(item1) || !this._itemIsCraftable(item2)) {
            this._log("smeltPair: one or both items are uncraftable.", LogLevel.WARN);
            return false;
        }
        if (!this._itemIsWeapon(item1) || !this._itemIsWeapon(item2)) {
            this._log("smeltPair: both items must be weapons.", LogLevel.WARN);
            return false;
        }
        const sheet1 = this.itemSheet[item1.def_index];
        const sheet2 = this.itemSheet[item2.def_index];
        const c1 = sheet1?.used_by_classes;
        const c2 = sheet2?.used_by_classes;
        const allClass1 = c1 == null;
        const allClass2 = c2 == null;
        if (!allClass1 && !allClass2 && !c1.some(c => c2.includes(c))) {
            this._log(`smeltPair: items don't share a class (${(c1 || []).join('/')} vs ${(c2 || []).join('/')}).`, LogLevel.WARN);
            return false;
        }

        this._log(`Smelting ${sheet1?.item_name || item1.def_index} + ${sheet2?.item_name || item2.def_index}...`);
        this.tf2.craft([item1.id, item2.id]);
        return await this._waitForCraft();
    }

    // Junk weapons to scrap (default excludes melees and snipers' because they are useful for crafting objectors)
    async makeScrap(confirmCallback, config = DefaultJunkConfig) {
        const pair = this._getBestJunkPair(config);

        if (!pair) {
            // Distinguish "no junk at all" from "junk exists but can't pair".
            const pool = this._getJunkItems(config);
            if (pool.length === 0) {
                this._log("No scrappable junk weapons in backpack.", LogLevel.INFO);
            } else {
                const names = pool
                    .map(it => this.itemSheet[it.def_index]?.item_name || `defindex ${it.def_index}`)
                    .filter((v, i, a) => a.indexOf(v) === i); // unique names
                this._log(
                    `Have ${pool.length} junk weapon(s) but none share a class — can't form a pair.`,
                    LogLevel.INFO
                );
                this._log(`Items: ${names.join(', ')}`, LogLevel.INFO);
                this._log(`Wait for another same-class drop, or use \`weapons smelt <N>\` to force-smelt a stack.`, LogLevel.INFO);
            }
            return false;
        }
        
        const [target1, target2] = pair;
        this._log(`SMELT TARGETS: `, LogLevel.INFO);
        this._log(`- ${this.itemSheet[target1.def_index].item_name}`, LogLevel.INFO);
        this._log(`- ${this.itemSheet[target2.def_index].item_name}`, LogLevel.INFO);
        
        // Await the user's decision
        if (confirmCallback) {
            const proceed = await confirmCallback();
            if (!proceed) {
                this._log("Craft cancelled.", LogLevel.INFO);
                return false;
            }
        }

        // Execute craft
        this._log("Sending craft request...");
        this.tf2.craft([target1.id, target2.id]);
        return await this._waitForCraft();
    }

    // ------ TOKENS ------

    async craftClassToken(tokenType) {
        //TODO
    }

    async craftSlotToken(tokenType) {
        //TODO
    }

    // ------ Filtering Helpers ------

    _itemIsCraftable(item) {
        if (UncraftableOrigins.has(item.origin)) { return false };

        if (item.attribute && item.attribute.some(attr => attr.def_index === ItemAttribute.NEVER_CRAFTABLE)) {
            return false;
        }

        return true; 
    }

    _itemIsTradeable(item) {
        if (UntradeableOrigins.has(item.origin)) { return false };

        if (item.attribute && item.attribute.some(attr => attr.def_index === ItemAttribute.CANNOT_TRADE)) {
            return false;
        }

        return true;
    }
    
    _itemIsEquipped(item) {
        return (item.equipped_state && item.equipped_state.length > 0);
    }

    _itemIsWeapon(item) {
        return (this.itemSheet[item.def_index]["craft_material_type"] == ItemCraftType.WEAPON);
    }

    // unused in junk check
    _itemIsEquipSlot(equipSlot, item) {
        return (this.itemSheet[item.def_index]["item_slot"] == equipSlot);
    }

    // unused in junk check
    _itemBelongsToClass(tfClass, item) {
        const usedClasses = this.itemSheet[item.def_index]["used_by_classes"];
        // In the schema, null means allclass
        return (usedClasses == null || usedClasses.includes(tfClass.token.schemaClass));
    }

    // Does NOT check for dupes!
    _itemIsPossibleJunk(item, config = DefaultJunkConfig) {

        if ( ProtectedWeapons.has(item.def_index) ) { return false; } // Valuable uniques
        if ( item.quality !== ItemQuality.UNIQUE ) { return false; }
        if ( item.custom_name || item.custom_desc ) { return false; }
        if ( item.attribute && item.attribute.length > 0 ) { return false; } // (Killstreaks, Spells, Parts, Festivizers)

        if ( !config.useEquipped && this._itemIsEquipped(item) ) { return false; }
        if ( config.excludeSlots && config.excludeSlots.includes(this.itemSheet[item.def_index]["item_slot"]) ) { return false; }

        const usedClasses = this.itemSheet[item.def_index]["used_by_classes"];
        const isAllClass = usedClasses == null;
        // If any of the excluded classes are in the used classes, then it's not junk
        if ( config.excludeClasses && !isAllClass && config.excludeClasses.some((cls) => usedClasses.includes(cls.token.schemaClass)) ) { return false; }
        
        return (
            this._itemIsCraftable(item) &&
            this._itemIsTradeable(item) &&
            this._itemIsWeapon(item)
        );
    }
    
    // Filters backpack into just items that are able to be scrapped
    
    _getJunkItems(config = DefaultJunkConfig) {
    
        const weapons = this.tf2.backpack.filter(item => this._itemIsWeapon(item));

        // Group weapons by def index
        // This will create seperate groups for decorated weapons, original festives, and other random things.
        // Solution would be to map "weird" weapons to their original def. Not worth the time tbh.
        const weaponGroups = {};
        for (const weapon of weapons) {
            const def = weapon.def_index;
            
            if (!weaponGroups[def]) { weaponGroups[def] = []; }
            
            weaponGroups[def].push(weapon);
        }

        // Whittle down the junk groups
        const finalJunkPool = [];
        for (const group of Object.values(weaponGroups)) {
        
            const originalCount = group.length;

            // Only keep "clean" weapons in the junk pile
            let junkableItems = group.filter( (item) =>
                this._itemIsPossibleJunk(item, config)
            );

            // If items were not stripped from the group (or we always want to keep a clean spare),
            //  strip one clean item from the junk group.
            if (config.keepCleanSpare || junkableItems.length == originalCount) {
                junkableItems.pop();
            }

            // Push each item onto the final junk pool
            finalJunkPool.push(...junkableItems);
        }

        return finalJunkPool;
        
    }

    // Used in junk pair algorithm
    _getItemFlexibility(item) {
        const usedClasses = this.itemSheet[item.def_index]["used_by_classes"];
        // If it has specific classes, return that number. 
        // If it's null (all-class), return 9 so it gets sorted to the very back
        return usedClasses ? usedClasses.length : Object.keys(TFClasses).length;
    }

    // Gets the best pair of junk items to turn to scrap
    _getBestJunkPair(config = DefaultJunkConfig) {
    
        const itemPool = this._getJunkItems(config);

        // Sort the pool with most restrictive weapons at the front (we want to use them before multiclass weps)
        itemPool.sort((a, b) => this._getItemFlexibility(a) - this._getItemFlexibility(b));

        const ALL_CLASSES = Object.values(TFClasses);

        // N^2 Search to find a pair with matching classes
        for (let i = 0; i < itemPool.length; i++) {
            const item1 = itemPool[i];
            let classes1 = this.itemSheet[item1.def_index]["used_by_classes"] || ALL_CLASSES;

            for (let j = i + 1; j < itemPool.length; j++) {
                const item2 = itemPool[j];
                let classes2 = this.itemSheet[item2.def_index]["used_by_classes"] || ALL_CLASSES;

                if (classes1.some( (cls) => classes2.includes(cls) )) {
                    return [item1, item2]; 
                }
            }
        }

        // If the loops finish and find nothing, return null
        return null; 
    }

    // ------ Craft Helpers ------

    // Listens for craftingComplete event, default timeout
    _waitForCraft(timeoutMs = TIMEOUT_MS) {
        return new Promise((resolve) => {
        
            let timeout;
            
            const listener = (recipe, itemsGained) => {
                clearTimeout(timeout);
                if (recipe < 0) {
                    this._log(`Craft Failed (recipe ${recipe}, gained ${itemsGained.length} items).`, LogLevel.WARN);
                    resolve(false);
                } else {
                    this._log(`Craft successful! Gained ${itemsGained.length} items using recipe ${recipe}.`, LogLevel.DONE);
                    resolve(true);
                }
            };
        
            timeout = setTimeout(() => {
                this._log("Crafting request timed out. The Game Coordinator might be down.", LogLevel.WARN);
                this.tf2.removeListener('craftingComplete', listener);
                resolve(false);
            }, timeoutMs);

            this.tf2.once('craftingComplete', listener);
        })
    }

    // Generic tally helper (used for getMetalTally and getTokenTally)
    _getCountsFor(targetItemsArray) {
        const result = {};
        const lookup = {};
    
        // Build lookup and initialize
        for (const target of targetItemsArray) {
            lookup[target.def] = target.name;
            // Initialize to tuple so we can refer to the original object when looping through the result
            result[target.name] = [target, 0];
        }
    
        // Single-Pass Tally
        for (const item of this.tf2.backpack) {
            const matchName = lookup[item.def_index];
            if (matchName) {
                result[matchName][1]++;
            }
        }
    
        return result;
    }

    _getAll(def) {
        return this.tf2.backpack.filter(item => item.def_index === def);
    }

}

export default Crafter;
