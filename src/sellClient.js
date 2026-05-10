import { LogLevel } from './constants.js';

const BASE = 'https://backpack.tf/api';
const AGENT_NAME = 'tf2-easycrafter/0.1';

class SellClient {
    constructor(logFn = () => {}) {
        this._log = logFn;
        this.token = process.env.BPTF_USER_TOKEN || null;
        this._agentLastPulse = 0;
    }

    isConfigured() { return !!this.token; }

    // backpack.tf requires an active "user agent" for listings to remain published.
    // Pulse lasts ~30 min; we throttle to once every 25 min within a session.
    async pulseAgent() {
        if (!this.isConfigured()) return false;
        if (Date.now() - this._agentLastPulse < 25 * 60 * 1000) return true;

        const url = `${BASE}/agent/pulse`;
        let res;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers: {
                    'User-Agent': AGENT_NAME,
                    'Accept': 'application/json',
                    'X-Auth-Token': this.token,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ user_agent: AGENT_NAME }),
            });
        } catch (err) {
            this._log(`Agent pulse network error: ${err?.message || err}`, LogLevel.WARN);
            return false;
        }
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            this._log(`Agent pulse failed: HTTP ${res.status}. Body: ${body.slice(0, 300)}`, LogLevel.WARN);
            return false;
        }
        this._agentLastPulse = Date.now();
        this._log('Agent pulse OK — listings active for ~30 min.', LogLevel.INFO);
        return true;
    }

    // Force backpack.tf to refresh its cached copy of this user's inventory.
    // Required when items have been recently traded/crafted/smelted; otherwise
    // listings 500 with "Item could not be resolved".
    async refreshInventory(steamid64) {
        if (!this.isConfigured()) return false;
        const url = `${BASE}/inventory/${encodeURIComponent(steamid64)}/refresh`;
        let res;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers: {
                    'User-Agent': AGENT_NAME,
                    'X-Auth-Token': this.token,
                },
            });
        } catch (err) {
            this._log(`Inventory refresh network error: ${err?.message || err}`, LogLevel.WARN);
            return false;
        }
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            this._log(`Inventory refresh failed: HTTP ${res.status}. Body: ${body.slice(0, 300)}`, LogLevel.WARN);
            return false;
        }
        this._log('Inventory refresh queued on backpack.tf.', LogLevel.INFO);
        return true;
    }

    // Check inventory cache status — useful to know if the refresh has completed.
    async getInventoryStatus(steamid64) {
        if (!this.isConfigured()) return null;
        const url = `${BASE}/inventory/${encodeURIComponent(steamid64)}/status`;
        try {
            const res = await fetch(url, {
                method: 'GET',
                headers: {
                    'User-Agent': AGENT_NAME,
                    'Accept': 'application/json',
                    'X-Auth-Token': this.token,
                },
            });
            if (!res.ok) return null;
            return await res.json();
        } catch {
            return null;
        }
    }

    async createListing({ itemId, refPrice, details = '' }) {
        if (!this.isConfigured()) {
            return { ok: false, error: 'BPTF_USER_TOKEN not configured' };
        }

        // Spec requires `id` as integer; TF2's GC returns it as a string.
        const numericId = typeof itemId === 'number' ? itemId : Number(itemId);
        if (!Number.isFinite(numericId) || !Number.isInteger(numericId)) {
            return { ok: false, error: `Invalid item id: ${itemId}` };
        }

        const body = {
            id: numericId,
            intent: 1, // 1 = sell
            currencies: { metal: refPrice },
            details,
        };
        const url = `${BASE}/v2/classifieds/listings`;
        let res;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers: {
                    'User-Agent': AGENT_NAME,
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'X-Auth-Token': this.token,
                },
                body: JSON.stringify(body),
            });
        } catch (err) {
            return { ok: false, error: err?.message || String(err) };
        }
        const text = await res.text();
        if (!res.ok) {
            return { ok: false, status: res.status, body: text };
        }
        try {
            return { ok: true, status: res.status, data: JSON.parse(text) };
        } catch {
            return { ok: true, status: res.status, data: text };
        }
    }
}

// Round price to nearest half-scrap (0.055 ref = 1 weapon-equivalent).
// backpack.tf accepts arbitrary decimals but listings render best at .05/.11 increments.
export function roundSellPrice(ref) {
    if (ref == null) return ref;
    // Round to nearest 0.05 (half-scrap)
    return Math.round(ref * 20) / 20;
}

export default SellClient;
