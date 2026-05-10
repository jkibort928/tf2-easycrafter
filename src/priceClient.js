import { promises as fsPromises } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { LogLevel } from './constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '..', '.cache');
const CACHE_PATH = path.join(CACHE_DIR, 'bptf-prices.json');

const PRICES_URL = 'https://backpack.tf/api/IGetPrices/v4';
const TF2_APPID = 440;
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

class PriceClient {
    constructor(logFn = () => {}) {
        this._log = logFn;
        this.apiKey = process.env.BPTF_API_KEY || null;
        this._priceData = null; // response.items keyed by item_name
        this._meta = null;      // { fetchedAt, raw_usd_value, currency }
    }

    isConfigured() { return !!this.apiKey; }

    // Loads from disk cache if fresh, else fetches and persists.
    async loadPrices({ forceRefresh = false, ttlMs = DEFAULT_TTL_MS } = {}) {
        if (!this.isConfigured()) {
            this._log('No BPTF_API_KEY set — skipping price fetch.', LogLevel.DEBUG);
            return false;
        }

        if (!forceRefresh) {
            const cached = await this._readCache();
            if (cached && (Date.now() - cached.fetchedAt) < ttlMs) {
                this._priceData = cached.items;
                this._meta = { fetchedAt: cached.fetchedAt, raw_usd_value: cached.raw_usd_value };
                this._log(`Loaded ${Object.keys(this._priceData).length} priced items from cache.`, LogLevel.DEBUG);
                return true;
            }
        }

        const url = `${PRICES_URL}?key=${encodeURIComponent(this.apiKey)}&appid=${TF2_APPID}`;
        this._log('Fetching price schema from backpack.tf...', LogLevel.INFO);

        let res;
        try {
            res = await fetch(url, {
                headers: {
                    'User-Agent': 'tf2-easycrafter/0.1 (+local CLI)',
                    'Accept': 'application/json',
                },
            });
        } catch (err) {
            this._log(`Network error fetching prices: ${err?.message || err}`, LogLevel.ERROR);
            return false;
        }

        if (!res.ok) {
            const body = await res.text().catch(() => '');
            const snippet = body.slice(0, 300).replace(/\s+/g, ' ');
            this._log(`Price fetch failed: HTTP ${res.status}. Body: ${snippet || '(empty)'}`, LogLevel.ERROR);
            if (res.status === 403) {
                this._log('403 usually means: (a) using the user token from Connections instead of the dev API key from /developer/apikey, or (b) the key is revoked. Verify at https://backpack.tf/developer/apikey', LogLevel.WARN);
            }
            return false;
        }

        const json = await res.json();
        const response = json?.response;
        if (!response || response.success !== 1 || !response.items) {
            this._log(`Price response malformed (success=${response?.success}).`, LogLevel.ERROR);
            return false;
        }

        this._priceData = response.items;
        this._meta = { fetchedAt: Date.now(), raw_usd_value: response.raw_usd_value };
        await this._writeCache(this._priceData, this._meta);
        this._log(`Fetched ${Object.keys(this._priceData).length} priced items.`, LogLevel.DONE);
        return true;
    }

    // Standard lookup: Unique (Q6), Tradable, Craftable.
    // Returns price in refined metal, or null if unpriced.
    getRefPrice(itemName, { quality = 6, tradable = true, craftable = true } = {}) {
        if (!this._priceData) return null;
        const entry = this._priceData[itemName];
        if (!entry?.prices) return null;

        const qualityBlock = entry.prices[String(quality)];
        if (!qualityBlock) return null;

        const tradeBlock = qualityBlock[tradable ? 'Tradable' : 'Non-Tradable'];
        if (!tradeBlock) return null;

        const craftBlock = tradeBlock[craftable ? 'Craftable' : 'Non-Craftable'];
        if (!craftBlock) return null;

        // Craftable can be an array (standard) or object keyed by particle id (unusuals).
        let priceObj;
        if (Array.isArray(craftBlock)) {
            priceObj = craftBlock[0];
        } else if (typeof craftBlock === 'object') {
            const firstKey = Object.keys(craftBlock)[0];
            priceObj = craftBlock[firstKey];
        }

        if (!priceObj || priceObj.currency !== 'metal') return null;
        const value = (priceObj.value + (priceObj.value_high ?? priceObj.value)) / 2;
        return Number.isFinite(value) ? value : null;
    }

    getMeta() { return this._meta; }

    async _readCache() {
        try {
            const raw = await fsPromises.readFile(CACHE_PATH, 'utf8');
            return JSON.parse(raw);
        } catch (err) {
            if (err?.code !== 'ENOENT') {
                this._log(`Cache read error: ${err?.message || err}`, LogLevel.WARN);
            }
            return null;
        }
    }

    async _writeCache(items, meta) {
        try {
            await fsPromises.mkdir(CACHE_DIR, { recursive: true });
            const payload = { items, fetchedAt: meta.fetchedAt, raw_usd_value: meta.raw_usd_value };
            await fsPromises.writeFile(CACHE_PATH, JSON.stringify(payload), 'utf8');
        } catch (err) {
            this._log(`Cache write error: ${err?.message || err}`, LogLevel.WARN);
        }
    }
}

export default PriceClient;
