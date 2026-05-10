import { promises as fs } from 'fs';
import path from 'path';

const DEFAULT_TF2_PATH = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Team Fortress 2';
const VPK_NAME = 'no_friends_list.vpk';
const DISABLED_SUFFIX = '.disabled';

export function getTf2Path() {
    return process.env.TF2_PATH || DEFAULT_TF2_PATH;
}

function vpkPaths(tf2Path) {
    const dir = path.join(tf2Path, 'tf', 'custom');
    return {
        enabled: path.join(dir, VPK_NAME),
        disabled: path.join(dir, VPK_NAME + DISABLED_SUFFIX),
    };
}

async function exists(p) {
    try { await fs.access(p); return true; } catch { return false; }
}

export async function getHideFriendsState(tf2Path) {
    const { enabled, disabled } = vpkPaths(tf2Path);
    const [hasEnabled, hasDisabled] = await Promise.all([exists(enabled), exists(disabled)]);
    if (hasEnabled && hasDisabled) return 'conflict';
    if (hasEnabled) return 'enabled';
    if (hasDisabled) return 'disabled';
    return 'missing';
}

export async function setHideFriends(tf2Path, enable) {
    const { enabled, disabled } = vpkPaths(tf2Path);
    const state = await getHideFriendsState(tf2Path);

    if (state === 'missing') {
        throw new Error(`VPK not found at ${enabled} (or ${DISABLED_SUFFIX}). Build it first.`);
    }
    if (state === 'conflict') {
        throw new Error(`Both ${VPK_NAME} and ${VPK_NAME}${DISABLED_SUFFIX} exist. Resolve manually.`);
    }

    const target = enable ? 'enabled' : 'disabled';
    if (state === target) return { changed: false, state };

    if (enable) {
        await fs.rename(disabled, enabled);
    } else {
        await fs.rename(enabled, disabled);
    }
    // Steam regenerates these on next launch; stale cache pointing at the renamed file is harmless but tidy to remove.
    for (const cache of [enabled + '.sound.cache', disabled + '.sound.cache']) {
        try { await fs.unlink(cache); } catch {}
    }
    return { changed: true, state: target };
}

const GAMEINFO_REL = path.join('tf', 'gameinfo.txt');
const CUSTOM_LINE_RE = /^(\s*)([a-zA-Z+_]+)(\s+tf\/custom\/\*\s*)$/;

export function gameInfoPath(tf2Path) {
    return path.join(tf2Path, GAMEINFO_REL);
}

export async function readGameInfoCustomLine(tf2Path) {
    const raw = await fs.readFile(gameInfoPath(tf2Path), 'utf8');
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(CUSTOM_LINE_RE);
        if (m) return { lineIdx: i, indent: m[1], tags: m[2], suffix: m[3], lines, eol: raw.includes('\r\n') ? '\r\n' : '\n' };
    }
    return null;
}

export async function isGameInfoPatched(tf2Path) {
    const found = await readGameInfoCustomLine(tf2Path);
    if (!found) return false;
    return /\bvgui\b/.test(found.tags);
}

export async function patchGameInfo(tf2Path) {
    const found = await readGameInfoCustomLine(tf2Path);
    if (!found) throw new Error(`Could not locate the tf/custom/* line in ${gameInfoPath(tf2Path)}`);
    if (/\bvgui\b/.test(found.tags)) return { changed: false };

    const newTags = found.tags + '+vgui';
    found.lines[found.lineIdx] = found.indent + newTags + found.suffix;
    await fs.writeFile(gameInfoPath(tf2Path), found.lines.join(found.eol));
    return { changed: true, oldTags: found.tags, newTags };
}
