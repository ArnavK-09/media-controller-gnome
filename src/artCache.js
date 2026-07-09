// SPDX-License-Identifier: GPL-2.0-or-later
/* artCache.js
 *
 * Resolves an MPRIS `mpris:artUrl` to a local file path that St can paint as a
 * background-image. Local files pass straight through; remote art (Spotify, web
 * browsers) is downloaded once and cached on disk.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const MAX_ART_BYTES = 8 * 1024 * 1024;

export class ArtCache {
    constructor() {
        this._session = new Soup.Session({timeout: 15});
        this._cancellable = new Gio.Cancellable();
        this._pending = new Map();

        this._cacheDir = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_cache_dir(), 'media-controller', 'art']));
        try {
            this._cacheDir.make_directory_with_parents(null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                console.warn(`media-controller: art cache dir: ${e.message}`);
        }
    }

    /**
     * @param {string} url an artUrl from MPRIS metadata
     * @returns {Promise<string|null>} a local path, or null when unavailable
     */
    async resolve(url) {
        if (!url)
            return null;

        if (url.startsWith('file://')) {
            const file = Gio.File.new_for_uri(url);
            const path = file.get_path();
            return path && GLib.file_test(path, GLib.FileTest.EXISTS) ? path : null;
        }

        if (!url.startsWith('http://') && !url.startsWith('https://'))
            return null;

        const name = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, url, -1);
        const target = this._cacheDir.get_child(name);
        const path = target.get_path();

        if (GLib.file_test(path, GLib.FileTest.EXISTS))
            return path;

        /* Two tracks can request the same art before the first fetch lands. */
        if (this._pending.has(url))
            return this._pending.get(url);

        const download = this._download(url, target)
            .finally(() => this._pending.delete(url));
        this._pending.set(url, download);
        return download;
    }

    /* GJS does not promisify GIO-style async methods on its own, and patching
     * the prototypes would affect every consumer in the shell process. */
    _sendAndRead(message) {
        return new Promise((resolve, reject) => {
            this._session.send_and_read_async(
                message, GLib.PRIORITY_DEFAULT, this._cancellable,
                (session, result) => {
                    try {
                        resolve(session.send_and_read_finish(result));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    _writeBytes(file, bytes) {
        return new Promise((resolve, reject) => {
            file.replace_contents_bytes_async(
                bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION,
                this._cancellable,
                (target, result) => {
                    try {
                        target.replace_contents_finish(result);
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    async _download(url, target) {
        try {
            const message = Soup.Message.new('GET', url);
            const bytes = await this._sendAndRead(message);

            if (message.get_status() !== Soup.Status.OK)
                return null;

            const size = bytes?.get_size() ?? 0;
            if (size === 0 || size > MAX_ART_BYTES)
                return null;

            await this._writeBytes(target, bytes);
            return target.get_path();
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.warn(`media-controller: art download failed: ${e.message}`);
            return null;
        }
    }

    destroy() {
        this._cancellable.cancel();
        this._pending.clear();
        this._session.abort();
        this._session = null;
    }
}
