import { LogLevel } from './constants.js';
import { DefaultJunkConfig } from './crafter.js';
import {
    ProtectedWeapons,
    ItemQuality,
    ItemCraftType,
    ItemEquipSlot,
    MetalType,
    SlotTokens,
    TFClasses,
} from './tf2Constants.js';

const METAL_DEFS = new Set([MetalType.SCRAP.def, MetalType.RECLAIMED.def, MetalType.REFINED.def]);
const SLOT_TOKEN_DEFS = new Set(Object.values(SlotTokens).map(t => t.def));
const CLASS_TOKEN_DEFS = new Set(Object.values(TFClasses).map(c => c.token.def));

const QUALITY_NAMES = {
    0: 'Normal', 1: 'Genuine', 3: 'Vintage', 5: 'Unusual', 6: 'Unique',
    7: 'Community', 8: 'Valve', 9: 'Self-Made', 10: 'Customized',
    11: 'Strange', 13: 'Haunted', 14: "Collector's", 15: 'Decorated',
};

// Convert a metal triple to total refined.
function toRef({ scrap = 0, reclaimed = 0, refined = 0 }) {
    return refined + reclaimed / 3 + scrap / 9;
}

// 1 ref = 9 scrap, formatted "X.YY ref"
function fmtRef(value) {
    if (value == null || !Number.isFinite(value)) return 'n/a';
    return `${value.toFixed(2)} ref`;
}

class Reviewer {
    constructor(engine, priceClient = null) {
        this.engine = engine;
        this.priceClient = priceClient;
    }

    async analyze({ usePrices = false, forceRefresh = false } = {}) {
        const backpack = this.engine.tf2.backpack;
        const itemSheet = this.engine.itemSheet;

        const report = {
            inventory: {
                total: backpack.length,
                capacity: this.engine.getSlots(),
                byCategory: {},
            },
            metal: { scrap: 0, reclaimed: 0, refined: 0, totalRef: 0 },
            tokens: { class: {}, slot: {} },
            weapons: {
                junkPotential: { count: 0, defGroups: 0 },
                estimatedYield: null,
            },
            dupes: { weapons: [], cosmetics: [], other: [] },
            recommendations: [],
            prices: null,
        };

        // Categorize and bucket
        const groups = new Map(); // def_index -> [items]
        for (const item of backpack) {
            const def = item.def_index;
            const sheet = itemSheet[def] || {};
            const category = this._categorize(item, sheet);
            report.inventory.byCategory[category] = (report.inventory.byCategory[category] || 0) + 1;

            if (METAL_DEFS.has(def)) {
                if (def === MetalType.SCRAP.def) report.metal.scrap++;
                else if (def === MetalType.RECLAIMED.def) report.metal.reclaimed++;
                else if (def === MetalType.REFINED.def) report.metal.refined++;
                continue;
            }

            if (SLOT_TOKEN_DEFS.has(def)) {
                const token = Object.values(SlotTokens).find(t => t.def === def);
                report.tokens.slot[token.displayName] = (report.tokens.slot[token.displayName] || 0) + 1;
                continue;
            }

            if (CLASS_TOKEN_DEFS.has(def)) {
                const cls = Object.values(TFClasses).find(c => c.token.def === def);
                report.tokens.class[cls.token.displayName] = (report.tokens.class[cls.token.displayName] || 0) + 1;
                continue;
            }

            if (!groups.has(def)) groups.set(def, []);
            groups.get(def).push(item);
        }

        report.metal.totalRef = toRef(report.metal);

        // Dupe detection across all groups.
        // For weapons we also surface groups with 2+ instances even when only 1 is "clean",
        // so the user sees the total count match what they observe in-game.
        for (const [def, items] of groups) {
            const sheet = itemSheet[def] || {};
            const category = this._categorize(items[0], sheet);
            const clean = items.filter(it => this._isCleanDupe(it, category));
            const modified = items.filter(it => !this._isCleanDupe(it, category));

            const isMultiWeapon = category === 'weapon' && items.length >= 2;
            const isCleanDupeGroup = clean.length >= 2;
            if (!isMultiWeapon && !isCleanDupeGroup) continue;

            const protectionReason = category === 'weapon' ? this._weaponProtectionReason(sheet) : null;
            const spareCount = Math.max(0, clean.length - 1);
            const modifiedCount = modified.length;

            const dupeRecord = {
                defIndex: def,
                name: sheet.item_name || `defindex ${def}`,
                category,
                totalCount: items.length,
                cleanCount: clean.length,
                modifiedCount,
                spareCount,
                protectionReason, // 'protected' | 'melee' | 'sniper' | null
                smeltable: category === 'weapon' && !protectionReason && spareCount > 0,
                cleanItems: clean,
                modifiedItems: modified,
                items: clean, // backwards compat
            };

            if (category === 'weapon') report.dupes.weapons.push(dupeRecord);
            else if (category === 'cosmetic') report.dupes.cosmetics.push(dupeRecord);
            else report.dupes.other.push(dupeRecord);
        }

        // Sort dupes: clean spares first (descending), then total count.
        const sortBySpares = (a, b) => (b.spareCount - a.spareCount) || (b.totalCount - a.totalCount);
        report.dupes.weapons.sort(sortBySpares);
        report.dupes.cosmetics.sort(sortBySpares);
        report.dupes.other.sort(sortBySpares);

        // Weapon junk math — respect crafter's exclusions (melees, snipers, protected) AND
        // its same-class pair-finding constraint. Items spread across distinct single-class
        // pools (e.g. one Medic + one Pyro + one Soldier) yield zero pairs even with 3 spares.
        const smeltableSpares = report.dupes.weapons
            .filter(d => d.smeltable)
            .reduce((sum, d) => sum + d.spareCount, 0);
        const protectedSpares = report.dupes.weapons
            .filter(d => !d.smeltable && d.spareCount > 0)
            .reduce((sum, d) => sum + d.spareCount, 0);

        const actualPairs = this._simulatePairing(report.dupes.weapons, itemSheet);

        report.weapons.junkPotential.count = smeltableSpares;
        report.weapons.junkPotential.protectedCount = protectedSpares;
        report.weapons.junkPotential.defGroups = report.dupes.weapons.filter(d => d.smeltable).length;

        const yieldedScrap = actualPairs;
        const orphans = smeltableSpares - actualPairs * 2;
        const projected = {
            scrap: report.metal.scrap + yieldedScrap,
            reclaimed: report.metal.reclaimed,
            refined: report.metal.refined,
        };
        report.weapons.estimatedYield = {
            extraScrap: yieldedScrap,
            unpairableLeftover: orphans,
            projectedTotalRef: toRef(projected),
            metalGainedRef: yieldedScrap / 9,
        };

        // Phase 2: prices
        if (usePrices && this.priceClient) {
            report.prices = await this._priceAnalysis(report, itemSheet, { forceRefresh });
        }

        // Recommendations
        report.recommendations = this._buildRecommendations(report);

        return report;
    }

    _categorize(item, sheet) {
        const def = item.def_index;
        if (METAL_DEFS.has(def)) return 'metal';
        if (SLOT_TOKEN_DEFS.has(def) || CLASS_TOKEN_DEFS.has(def)) return 'token';

        const craftType = sheet.craft_material_type;
        if (craftType === ItemCraftType.WEAPON) return 'weapon';
        if (craftType === 'hat' || craftType === 'craft_bar' || craftType === 'cosmetic') return 'cosmetic';

        const itemClass = sheet.item_class || '';
        if (itemClass.startsWith('tf_wearable')) return 'cosmetic';
        if (itemClass === 'supply_crate') return 'crate';
        if (itemClass === 'tool') return 'tool';
        if (itemClass === 'tf_powerup_bottle') return 'tool';

        const itemTypeName = (sheet.item_type_name || '').toLowerCase();
        if (itemTypeName.includes('cosmetic')) return 'cosmetic';
        if (itemTypeName.includes('taunt')) return 'taunt';
        if (itemTypeName.includes('paint')) return 'paint';

        return 'other';
    }

    _isCleanDupe(item, category) {
        if (item.quality !== ItemQuality.UNIQUE) return false;
        if (item.custom_name || item.custom_desc) return false;
        if (ProtectedWeapons.has(item.def_index)) return false;

        // Attribute filter: only weapons and cosmetics are made non-fungible by attributes
        // (Strange, Killstreak, Festive, Painted, Spelled). Tools/crates/etc. carry inherent
        // attributes that don't change interchangeability.
        const strictCategories = category === 'weapon' || category === 'cosmetic';
        if (strictCategories && item.attribute && item.attribute.length > 0) return false;

        return true;
    }

    // Mirrors crafter._getBestJunkPair: pair items that share at least one class,
    // remove them, and repeat until no overlapping pair remains. Returns pair count.
    _simulatePairing(weaponDupes, itemSheet) {
        const ALL_CLASSES = Object.values(TFClasses).map(c => c.token.schemaClass);
        const pool = [];
        for (const d of weaponDupes) {
            if (!d.smeltable) continue;
            const sheet = itemSheet[d.defIndex] || {};
            const classes = sheet.used_by_classes || ALL_CLASSES;
            for (let i = 0; i < d.spareCount; i++) {
                pool.push({ classes });
            }
        }
        // Sort by class flexibility ascending — same heuristic the crafter uses.
        pool.sort((a, b) => a.classes.length - b.classes.length);

        let pairs = 0;
        while (true) {
            let foundI = -1, foundJ = -1;
            outer: for (let i = 0; i < pool.length; i++) {
                for (let j = i + 1; j < pool.length; j++) {
                    if (pool[i].classes.some(c => pool[j].classes.includes(c))) {
                        foundI = i; foundJ = j;
                        break outer;
                    }
                }
            }
            if (foundI === -1) break;
            // Splice in reverse order so indexes stay valid.
            pool.splice(foundJ, 1);
            pool.splice(foundI, 1);
            pairs++;
        }
        return pairs;
    }

    // Returns the reason a weapon def is protected from auto-smelt, matching
    // crafter.DefaultJunkConfig's behavior. Returns null if smeltable.
    _weaponProtectionReason(sheet) {
        if (!sheet) return null;
        const def = sheet.defindex;
        if (def != null && ProtectedWeapons.has(def)) return 'protected';
        if (DefaultJunkConfig.excludeSlots && DefaultJunkConfig.excludeSlots.includes(sheet.item_slot)) {
            return sheet.item_slot === ItemEquipSlot.MELEE ? 'melee' : 'slot';
        }
        const usedClasses = sheet.used_by_classes;
        const isAllClass = usedClasses == null;
        if (DefaultJunkConfig.excludeClasses && !isAllClass) {
            for (const cls of DefaultJunkConfig.excludeClasses) {
                if (usedClasses.includes(cls.token.schemaClass) || usedClasses.includes(cls.fullName)) {
                    return cls.name; // e.g. 'sniper'
                }
            }
        }
        return null;
    }

    async _priceAnalysis(report, itemSheet, { forceRefresh = false } = {}) {
        const ok = await this.priceClient.loadPrices({ forceRefresh });
        if (!ok) {
            return { error: 'Failed to load price data', enabled: false, configured: this.priceClient.isConfigured() };
        }

        // Value every backpack item we can price, including non-dupes.
        const valued = []; // { name, defIndex, ref, quality, count }
        const counts = new Map(); // key -> { ref, count, name, defIndex }

        for (const item of this.engine.tf2.backpack) {
            const sheet = itemSheet[item.def_index];
            if (!sheet) continue;
            const ref = this.priceClient.getRefPrice(sheet.item_name, {
                quality: item.quality,
                tradable: this._isTradeableForPrice(item),
                craftable: this._isCraftableForPrice(item),
            });
            if (ref == null) continue;

            const key = `${item.def_index}:${item.quality}`;
            if (!counts.has(key)) {
                counts.set(key, { name: sheet.item_name, defIndex: item.def_index, quality: item.quality, ref, count: 1 });
            } else {
                counts.get(key).count += 1;
            }
        }

        let totalRef = 0;
        for (const v of counts.values()) {
            totalRef += v.ref * v.count;
            valued.push(v);
        }

        // Add metal itself to total
        totalRef += report.metal.totalRef;

        // Top items by per-item ref
        const topByUnit = [...valued].sort((a, b) => b.ref - a.ref).slice(0, 10);
        // Top groups by total ref held
        const topByHolding = [...valued].sort((a, b) => (b.ref * b.count) - (a.ref * a.count)).slice(0, 10);

        // Annotate dupes with prices for both clean and modified instances.
        const annotateDupes = (list) => {
            for (const d of list) {
                const refPrice = this.priceClient.getRefPrice(d.name, { quality: ItemQuality.UNIQUE });
                if (refPrice != null) {
                    d.refPerItem = refPrice;
                    d.spareValueRef = refPrice * d.spareCount;
                }

                // Modified instances: group by quality, look up each price
                if (d.modifiedItems && d.modifiedItems.length > 0) {
                    const byQuality = new Map();
                    for (const item of d.modifiedItems) {
                        const q = item.quality;
                        if (!byQuality.has(q)) byQuality.set(q, 0);
                        byQuality.set(q, byQuality.get(q) + 1);
                    }
                    d.modifiedBreakdown = [];
                    let modifiedTotalRef = 0;
                    for (const [quality, count] of byQuality) {
                        const price = this.priceClient.getRefPrice(d.name, { quality });
                        const totalRef = price != null ? price * count : null;
                        if (totalRef != null) modifiedTotalRef += totalRef;
                        d.modifiedBreakdown.push({
                            quality,
                            qualityName: QUALITY_NAMES[quality] || `Quality ${quality}`,
                            count,
                            refPerItem: price,
                            totalRef,
                        });
                    }
                    d.modifiedBreakdown.sort((a, b) => (b.totalRef || 0) - (a.totalRef || 0));
                    d.modifiedTotalRef = modifiedTotalRef;
                }
            }
            list.sort((a, b) => (b.spareValueRef || 0) - (a.spareValueRef || 0));
        };
        annotateDupes(report.dupes.weapons);
        annotateDupes(report.dupes.cosmetics);
        annotateDupes(report.dupes.other);

        const meta = this.priceClient.getMeta() || {};
        return {
            enabled: true,
            totalRef,
            usdValue: meta.raw_usd_value ? totalRef * meta.raw_usd_value : null,
            usdPerRef: meta.raw_usd_value || null,
            fetchedAt: meta.fetchedAt,
            pricedItemCount: valued.reduce((s, v) => s + v.count, 0),
            topByUnit,
            topByHolding,
        };
    }

    _isTradeableForPrice(item) {
        // Lightweight check; the full crafter logic is more nuanced but for pricing the broad case is fine.
        return !(item.attribute && item.attribute.some(a => a.def_index === 153));
    }

    _isCraftableForPrice(item) {
        return !(item.attribute && item.attribute.some(a => a.def_index === 449));
    }

    _buildRecommendations(report) {
        const recs = [];
        const hasPrices = !!report.prices?.enabled;

        // Price-aware sell recommendations: rank dupe groups by total ref impact.
        // Surface every priced dupe — including cheap items that are still worth listing
        // in batches (e.g. 4× Winter cases at 0.28 ref ea).
        if (hasPrices) {
            const allDupes = [
                ...report.dupes.weapons.map(d => ({ ...d, bucket: 'weapon' })),
                ...report.dupes.cosmetics.map(d => ({ ...d, bucket: 'cosmetic' })),
                ...report.dupes.other.map(d => ({ ...d, bucket: 'other' })),
            ].filter(d =>
                d.spareCount > 0 &&
                d.spareValueRef != null &&
                d.refPerItem != null
            );

            allDupes.sort((a, b) => b.spareValueRef - a.spareValueRef);

            for (const d of allDupes) {
                let priority;
                if (d.spareValueRef >= 50) priority = 'high';
                else if (d.spareValueRef >= 5) priority = 'medium';
                else priority = 'info';

                // Sell at median - 5% for slightly faster turnover, rounded to half-scrap.
                const rawSellPrice = d.refPerItem * 0.95;
                const sellPrice = Math.round(rawSellPrice * 20) / 20;
                const totalSell = sellPrice * d.spareCount;

                recs.push({
                    priority,
                    action: 'sell',
                    summary: `Sell ${d.spareCount}× ${d.name} @ ${fmtRef(sellPrice)} ea (~${fmtRef(totalSell)} total, median ${fmtRef(d.refPerItem)})`,
                    executable: {
                        kind: 'sell',
                        defIndex: d.defIndex,
                        name: d.name,
                        spareCount: d.spareCount,
                        medianRef: d.refPerItem,
                        sellPrice,
                    },
                });
            }
        }

        // Weapon dupes -> scrap. Recommend only if pair-finding will actually produce
        // pairs; otherwise note the orphans so the user knows why nothing's happening.
        const yield_ = report.weapons.estimatedYield;
        if (yield_ && yield_.extraScrap > 0) {
            const pairs = yield_.extraScrap;
            const consumed = pairs * 2;
            const hasBigSell = recs.some(r => r.priority === 'high' && r.action === 'sell');
            const orphanNote = yield_.unpairableLeftover
                ? `${yield_.unpairableLeftover} smeltable spare(s) can't pair (no same-class match)`
                : null;
            recs.push({
                priority: hasBigSell ? 'medium' : 'high',
                action: 'makescrap',
                summary: `Smelt ${consumed} dupe weapons → +${pairs} scrap (+${fmtRef(yield_.metalGainedRef)}, frees ${pairs} slots)`,
                detail: orphanNote,
                executable: { kind: 'makescrap', pairs },
            });
        } else if (report.weapons.junkPotential.count > 0) {
            recs.push({
                priority: 'info',
                action: 'note',
                summary: `${report.weapons.junkPotential.count} smeltable weapon spare(s) but none share a class — can't pair. Leave them or wait for a same-class drop.`,
                executable: null,
            });
        }

        // Metal balance: lots of scrap → combine
        if (report.metal.scrap >= 3) {
            const combinable = Math.floor(report.metal.scrap / 3);
            recs.push({
                priority: 'info',
                action: 'combine scrap',
                summary: `Combine ${combinable * 3} scrap → ${combinable} reclaimed (frees ${combinable * 2} slots)`,
                executable: { kind: 'combineMetal', metalName: 'SCRAP', batches: combinable },
            });
        }
        if (report.metal.reclaimed >= 3) {
            const combinable = Math.floor(report.metal.reclaimed / 3);
            recs.push({
                priority: 'info',
                action: 'combine rec',
                summary: `Combine ${combinable * 3} rec → ${combinable} ref (frees ${combinable * 2} slots)`,
                executable: { kind: 'combineMetal', metalName: 'RECLAIMED', batches: combinable },
            });
        }

        // Note about unpriced dupes (no rec since we don't know what they're worth).
        if (hasPrices) {
            const unpriced = [
                ...report.dupes.weapons,
                ...report.dupes.cosmetics,
                ...report.dupes.other,
            ].filter(d => d.spareCount > 0 && d.refPerItem == null);
            if (unpriced.length > 0) {
                const names = unpriced.slice(0, 5).map(d => d.name);
                const more = unpriced.length > 5 ? ` (+${unpriced.length - 5} more)` : '';
                recs.push({
                    priority: 'info',
                    action: 'note',
                    summary: `${unpriced.length} dupe group(s) have no backpack.tf price — list manually with your own price: ${names.join(', ')}${more}`,
                    executable: null,
                });
            }
        }

        // Cosmetic dupes that didn't make the price-aware sell list (no price or below threshold)
        if (!hasPrices && report.dupes.cosmetics.length > 0) {
            const totalSpares = report.dupes.cosmetics.reduce((s, d) => s + d.spareCount, 0);
            recs.push({
                priority: 'info',
                action: 'review cosmetic dupes',
                summary: `${totalSpares} dupe cosmetic(s) across ${report.dupes.cosmetics.length} group(s) — sell on backpack.tf rather than smelt (2 ref → 1 random hat is negative EV)`,
                executable: null,
            });
        }

        // Phase 2 nudge
        if (!hasPrices) {
            const wasConfigured = report.prices?.configured;
            recs.push({
                priority: 'info',
                action: 'enable prices',
                summary: wasConfigured
                    ? `BPTF_API_KEY is set but the price fetch failed (see log above). Verify the key at https://backpack.tf/developer/apikey.`
                    : `Set BPTF_API_KEY in .env to enable per-item ref valuation and ranked dupes.`,
                executable: null,
            });
        }

        return recs;
    }
}

export default Reviewer;
export { fmtRef, toRef };
