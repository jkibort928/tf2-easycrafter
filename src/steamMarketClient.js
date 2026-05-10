import { LogLevel } from './constants.js';

const MARKET_URL = 'https://steamcommunity.com/market';
const TF2_APPID = 440;
const TF2_CONTEXTID = 2;

class SteamMarketClient {
    constructor(steamUser, logFn = () => {}) {
        this.user = steamUser;
        this._log = logFn;
        this.cookies = null;
        this.sessionId = null;
        this.steamId64 = null;
        this._sessionPromise = null;
        this._cachedKeyRate = null; // { usdPerRef, fetchedAt }

        // steam-user emits webSession with the session details whenever they're available.
        steamUser.on('webSession', (sessionID, cookies) => {
            this.sessionId = sessionID;
            this.cookies = Array.isArray(cookies) ? cookies : [];
            this.steamId64 = steamUser.steamID?.getSteamID64?.() || null;
            this._log('Steam web session ready.', LogLevel.DEBUG);
        });
    }

    isReady() { return !!(this.cookies && this.sessionId); }

    async ensureWebSession(timeoutMs = 30000) {
        if (this.isReady()) return true;
        if (this._sessionPromise) return this._sessionPromise;

        this._log('Requesting Steam web session...', LogLevel.INFO);
        this._sessionPromise = new Promise((resolve) => {
            const onSession = () => resolve(true);
            this.user.once('webSession', onSession);
            try {
                this.user.webLogOn();
            } catch (err) {
                this.user.removeListener('webSession', onSession);
                this._log(`webLogOn error: ${err?.message || err}`, LogLevel.ERROR);
                resolve(false);
                return;
            }
            setTimeout(() => {
                this.user.removeListener('webSession', onSession);
                resolve(this.isReady());
            }, timeoutMs);
        });

        const ok = await this._sessionPromise;
        this._sessionPromise = null;
        return ok;
    }

    async getItemPriceOverview(marketHashName, currency = 1) {
        const url = `${MARKET_URL}/priceoverview/?appid=${TF2_APPID}&currency=${currency}&market_hash_name=${encodeURIComponent(marketHashName)}`;
        let res;
        try {
            res = await fetch(url, {
                headers: {
                    'User-Agent': 'tf2-easycrafter/0.1',
                    'Accept': 'application/json',
                },
            });
        } catch (err) {
            return null;
        }
        if (!res.ok) return null;
        try {
            const data = await res.json();
            if (data?.success !== true) return null;
            return {
                lowestCents: parsePriceToCents(data.lowest_price),
                medianCents: parsePriceToCents(data.median_price),
                volume: data.volume ? parseInt(String(data.volume).replace(/,/g, ''), 10) : 0,
            };
        } catch {
            return null;
        }
    }

    // Compute USD-per-ref using Mann Co. Supply Crate Key as the reference.
    // Cached for the session (rate moves slowly).
    async getRefToUsdRate(priceClient) {
        if (this._cachedKeyRate && Date.now() - this._cachedKeyRate.fetchedAt < 30 * 60 * 1000) {
            return this._cachedKeyRate;
        }
        if (!priceClient) return null;
        const keyRef = priceClient.getRefPrice('Mann Co. Supply Crate Key', { quality: 6 });
        if (!keyRef) {
            this._log('No backpack.tf key price — cannot compute USD/ref rate.', LogLevel.WARN);
            return null;
        }
        const overview = await this.getItemPriceOverview('Mann Co. Supply Crate Key');
        if (!overview?.lowestCents) {
            this._log('No Steam Market key price — cannot compute USD/ref rate.', LogLevel.WARN);
            return null;
        }
        const keyUsd = overview.lowestCents / 100;
        const usdPerRef = keyUsd / keyRef;
        this._cachedKeyRate = { usdPerRef, keyUsd, keyRef, fetchedAt: Date.now() };
        this._log(`Rate: 1 ref ≈ $${usdPerRef.toFixed(4)} (key = ${keyRef} ref ≈ $${keyUsd.toFixed(2)})`, LogLevel.INFO);
        return this._cachedKeyRate;
    }

    // Steam's sellitem endpoint takes the SELLER-RECEIVE amount as `price` (in cents).
    // Steam adds the ~15% fee on top for the buyer-display price.
    async listItem({ assetId, priceCents }) {
        if (!(await this.ensureWebSession())) {
            return { ok: false, error: 'Could not establish Steam web session' };
        }
        if (priceCents < 1) {
            return { ok: false, error: 'Price below Steam minimum (1 cent net)' };
        }

        const params = new URLSearchParams();
        params.set('sessionid', this.sessionId);
        params.set('appid', String(TF2_APPID));
        params.set('contextid', String(TF2_CONTEXTID));
        params.set('assetid', String(assetId));
        params.set('amount', '1');
        params.set('price', String(priceCents));

        const cookieHeader = this.cookies.join('; ');
        const referer = `https://steamcommunity.com/profiles/${this.steamId64}/inventory/`;

        let res;
        try {
            res = await fetch(`${MARKET_URL}/sellitem/`, {
                method: 'POST',
                headers: {
                    'Cookie': cookieHeader,
                    'Referer': referer,
                    'Origin': 'https://steamcommunity.com',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'tf2-easycrafter/0.1',
                    'Accept': 'text/javascript, text/html, application/xml, text/xml, */*',
                    'X-Requested-With': 'XMLHttpRequest',
                },
                body: params.toString(),
            });
        } catch (err) {
            return { ok: false, error: err.message || String(err) };
        }

        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 400) }; }

        if (!res.ok) {
            return { ok: false, status: res.status, body: data };
        }
        if (data?.success !== true) {
            return { ok: false, status: res.status, body: data };
        }
        return {
            ok: true,
            requiresConfirmation: data.requires_confirmation === 1 || data.needs_mobile_confirmation === true,
            data,
        };
    }
}

function parsePriceToCents(priceStr) {
    if (!priceStr) return null;
    // Strip currency symbols, normalize separators. Handles "$2.49", "2,49 €", "USD 2.49".
    const cleaned = String(priceStr).replace(/[^\d.,]/g, '');
    if (!cleaned) return null;

    let normalized = cleaned;
    const lastComma = cleaned.lastIndexOf(',');
    const lastDot = cleaned.lastIndexOf('.');
    if (lastComma > lastDot) {
        // European: comma is decimal separator
        normalized = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
        // US: dot is decimal, commas are thousands
        normalized = cleaned.replace(/,/g, '');
    }
    const n = parseFloat(normalized);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 100);
}

export default SteamMarketClient;
export { parsePriceToCents };
