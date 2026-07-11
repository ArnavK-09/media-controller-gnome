// SPDX-License-Identifier: GPL-2.0-or-later
/* mediaCard.js
 *
 * The iOS-style "now playing" card shown when the panel indicator is clicked.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Equalizer} from './equalizer.js';
import {US_PER_SECOND, loopIconName, nextLoopStatus, playPauseIconName,
    seekOffset, setToggleStyle} from './transport.js';

const POSITION_POLL_SECONDS = 1;

/* A wrapping title has no natural bound: the card is as tall as the text needs.
 * Podcast episodes and DJ sets routinely carry titles of a few hundred
 * characters, which would push the controls off the bottom of the screen. This
 * caps the title at roughly three lines at the default card width; the wrap
 * still does the real work, this only stops the pathological case. */
const MAX_TITLE_CHARS = 120;

/* Keyed by the `card-art-size` enum nick. `icon` sizes the fallback player icon
 * so it keeps roughly the same inset as the artwork it stands in for, and the
 * radius tracks the size so the corners stay proportionally round. */
const ART_SIZES = {
    'small': {size: 64, radius: 12, icon: 28},
    'medium': {size: 88, radius: 16, icon: 40},
    'large': {size: 120, radius: 20, icon: 56},
};
const DEFAULT_ART_SIZE = 'medium';

/**
 * Spreading the string iterates code points, so the cut never lands between the
 * halves of a surrogate pair and split an emoji into a broken glyph.
 *
 * @param {string} text @param {number} maxLength
 */
function truncate(text, maxLength) {
    const chars = [...text];
    if (chars.length <= maxLength)
        return text;
    return `${chars.slice(0, maxLength - 1).join('').trimEnd()}…`;
}

/** Hours only appear once there are some: `4:07`, but `1:23:20`. */
function formatTime(micros) {
    const total = Math.max(0, Math.floor(micros / US_PER_SECOND));
    const seconds = total % 60;
    const minutes = Math.floor(total / 60) % 60;
    const hours = Math.floor(total / 3600);

    const pad = value => value.toString().padStart(2, '0');
    if (hours > 0)
        return `${hours}:${pad(minutes)}:${pad(seconds)}`;
    return `${minutes}:${pad(seconds)}`;
}

/** St parses this as CSS, so a path with a quote in it must not break out. */
function cssUrl(path) {
    return `url("${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")`;
}

/* Secondary text; opacity keeps it legible in both light and dark themes,
 * which a hardcoded color would not. */
const DIM_OPACITY = 160;

/* `message-media-control` is the shell's own media button style, so hover,
 * active and insensitive states follow the current theme. */
function iconButton(iconName, styleClass) {
    return new St.Button({
        style_class: `message-media-control ${styleClass}`,
        can_focus: true,
        child: new St.Icon({icon_name: iconName}),
    });
}

export const MediaCard = GObject.registerClass({
    Signals: {
        /* Raised the player's window; the menu should close. */
        'activated': {},
        /* The gear button was pressed. */
        'open-preferences': {},
    },
}, class MediaCard extends St.BoxLayout {
    _init(artCache, settings) {
        super._init({
            style_class: 'mc-card',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        this._artCache = artCache;
        this._settings = settings;
        this._player = null;
        this._playerSignals = [];
        this._timeoutId = 0;
        this._seekRefreshId = 0;
        this._dragging = false;
        this._dragPlayer = null;
        this._dragLength = 0;
        this._active = false;
        this._currentArtUrl = null;
        this._artGeneration = 0;
        this._artPath = null;
        this._artSize = ART_SIZES[DEFAULT_ART_SIZE];
        this._length = 0;
        this._position = 0;

        this._buildHeader();
        this._buildSeekBar();
        this._buildControls();

        this._settingsSignals = [
            this._settings.connect('changed::card-show-art', () => this.sync()),
            this._settings.connect('changed::card-show-seek-bar', () => this.sync()),
            this._settings.connect('changed::card-show-seek-buttons', () => this.sync()),
            this._settings.connect('changed::card-show-shuffle', () => this.sync()),
            this._settings.connect('changed::card-show-loop', () => this.sync()),
            this._settings.connect('changed::card-width', () => this._applyWidth()),
            this._settings.connect('changed::card-art-size', () => this._applyArtSize()),
        ];
        this._applyWidth();
        this._applyArtSize();

        this.connect('destroy', () => this._onDestroy());
    }

    _buildHeader() {
        const header = new St.BoxLayout({
            style_class: 'mc-card-header',
            orientation: Clutter.Orientation.HORIZONTAL,
        });

        this._artBin = new St.Bin({
            style_class: 'mc-art',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._artFallback = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            opacity: DIM_OPACITY,
        });
        this._artBin.set_child(this._artFallback);
        header.add_child(this._artBin);

        const textBox = new St.BoxLayout({
            style_class: 'mc-card-text',
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        this._titleLabel = new St.Label({style_class: 'mc-card-title', text: _('Nothing playing')});
        this._subtitleLabel = new St.Label({
            style_class: 'mc-card-subtitle',
            text: '',
            opacity: DIM_OPACITY,
        });
        /* The card has a fixed width, so a long title wraps onto further lines
         * rather than being cut off. Breaking mid-word is the fallback for a
         * single word too long to fit on a line of its own. */
        this._titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._titleLabel.clutter_text.line_wrap = true;
        this._titleLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._subtitleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        textBox.add_child(this._titleLabel);
        textBox.add_child(this._subtitleLabel);
        header.add_child(textBox);

        /* A full-height column down the right edge: the gear pinned to the top
         * corner, and the player icon plus equalizer centred against the art. */
        const actions = new St.BoxLayout({
            style_class: 'mc-card-actions',
            orientation: Clutter.Orientation.VERTICAL,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
        });

        this._prefsButton = new St.Button({
            style_class: 'mc-app-button',
            can_focus: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
            child: new St.Icon({icon_name: 'emblem-system-symbolic', icon_size: 16}),
        });
        this._prefsButton.connect('clicked', () => this.emit('open-preferences'));
        actions.add_child(this._prefsButton);

        /* Expanding is what pushes this off the gear and centres it. */
        const status = new St.BoxLayout({
            style_class: 'mc-card-status',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
        });

        this._appButton = new St.Button({
            style_class: 'mc-app-button',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._appIcon = new St.Icon({icon_size: 16, style_class: 'mc-app-icon'});
        this._appButton.set_child(this._appIcon);
        this._appButton.connect('clicked', () => {
            this._player?.raise();
            this.emit('activated');
        });
        status.add_child(this._appButton);

        this._equalizer = new Equalizer();
        status.add_child(this._equalizer);
        actions.add_child(status);

        header.add_child(actions);
        this.add_child(header);
    }

    _buildSeekBar() {
        this._seekBox = new St.BoxLayout({
            style_class: 'mc-seek-box',
            orientation: Clutter.Orientation.VERTICAL,
        });

        this._slider = new Slider(0);
        this._slider.add_style_class_name('mc-seek');
        this._slider.x_expand = true;

        /* The track can advance while the thumb is held, and sync() would move
         * `_length` out from under the drag. Pin the player and the duration the
         * user is actually scrubbing against. */
        this._slider.connect('drag-begin', () => {
            this._dragging = true;
            this._dragPlayer = this._player;
            this._dragLength = this._length;
            return Clutter.EVENT_PROPAGATE;
        });
        this._slider.connect('drag-end', () => {
            this._dragging = false;
            const player = this._dragPlayer;
            const length = this._dragLength;
            this._dragPlayer = null;

            if (player && player === this._player && length > 0)
                player.setPosition(Math.round(this._slider.value * length));
            return Clutter.EVENT_PROPAGATE;
        });
        /* Keep the timestamps under the thumb while the user scrubs. */
        this._slider.connect('notify::value', () => {
            if (this._dragging && this._dragLength > 0) {
                this._updateTimeLabels(this._slider.value * this._dragLength,
                    this._dragLength);
            }
        });

        const times = new St.BoxLayout({
            style_class: 'mc-time-box',
            orientation: Clutter.Orientation.HORIZONTAL,
        });
        this._positionLabel = new St.Label({
            style_class: 'mc-time',
            text: '0:00',
            opacity: DIM_OPACITY,
        });
        this._remainingLabel = new St.Label({
            style_class: 'mc-time',
            text: '-0:00',
            opacity: DIM_OPACITY,
        });
        this._remainingLabel.x_align = Clutter.ActorAlign.END;
        this._remainingLabel.x_expand = true;
        times.add_child(this._positionLabel);
        times.add_child(this._remainingLabel);

        this._seekBox.add_child(this._slider);
        this._seekBox.add_child(times);
        this.add_child(this._seekBox);
    }

    _buildControls() {
        /* The row is a stack, not a box: shuffle is pinned to the left edge,
         * loop to the right, and the transport cluster is centred against the
         * full card width — so it does not shift when an edge button comes or
         * goes with the player's capabilities. */
        const row = new St.Widget({
            style_class: 'mc-controls-row',
            layout_manager: new Clutter.BinLayout(),
        });

        this._shuffleButton = iconButton('media-playlist-shuffle-symbolic',
            'mc-control-button mc-mode-button');
        this._shuffleButton.x_align = Clutter.ActorAlign.START;
        this._shuffleButton.y_align = Clutter.ActorAlign.CENTER;
        this._shuffleButton.connect('clicked', () => this._toggleShuffle());

        this._loopButton = iconButton('media-playlist-repeat-symbolic',
            'mc-control-button mc-mode-button');
        this._loopButton.x_align = Clutter.ActorAlign.END;
        this._loopButton.y_align = Clutter.ActorAlign.CENTER;
        this._loopButton.connect('clicked', () => this._cycleLoop());

        const controls = new St.BoxLayout({
            style_class: 'mc-card-controls',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._prevButton = iconButton('media-skip-backward-symbolic', 'mc-control-button');
        this._backButton = iconButton('media-seek-backward-symbolic', 'mc-control-button mc-seek-button');
        this._playButton = iconButton('media-playback-start-symbolic', 'mc-control-button mc-play-button');
        this._forwardButton = iconButton('media-seek-forward-symbolic', 'mc-control-button mc-seek-button');
        this._nextButton = iconButton('media-skip-forward-symbolic', 'mc-control-button');

        this._prevButton.connect('clicked', () => this._player?.previous());
        this._playButton.connect('clicked', () => this._player?.playPause());
        this._nextButton.connect('clicked', () => this._player?.next());
        this._backButton.connect('clicked', () => this._skip(-1));
        this._forwardButton.connect('clicked', () => this._skip(1));

        controls.add_child(this._prevButton);
        controls.add_child(this._backButton);
        controls.add_child(this._playButton);
        controls.add_child(this._forwardButton);
        controls.add_child(this._nextButton);

        row.add_child(this._shuffleButton);
        row.add_child(controls);
        row.add_child(this._loopButton);
        this.add_child(row);
    }

    _toggleShuffle() {
        if (!this._player)
            return;
        this._player.setShuffle(!this._player.shuffle);
        this.sync();
    }

    _cycleLoop() {
        if (!this._player)
            return;
        this._player.setLoopStatus(nextLoopStatus(this._player.loopStatus));
        this.sync();
    }

    /**
     * @param {number} direction -1 to rewind, 1 to skip ahead
     */
    _skip(direction) {
        if (!this._player)
            return;
        this._player.seek(seekOffset(this._settings, direction));

        /* Players that do not emit Seeked would otherwise leave the slider
         * stale until the next poll — and there is no poll while paused. */
        this._refreshPositionSoon();
    }

    _refreshPositionSoon() {
        if (this._seekRefreshId)
            GLib.Source.remove(this._seekRefreshId);
        this._seekRefreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._seekRefreshId = 0;
            this._refreshPosition();
            return GLib.SOURCE_REMOVE;
        });
    }

    _applyWidth() {
        this.style = `width: ${this._settings.get_int('card-width')}px;`;
    }

    /* The art bin's geometry and its background-image share one `style`
     * property, so both are written together rather than clobbering each other. */
    _applyArtSize() {
        const nick = this._settings.get_string('card-art-size');
        this._artSize = ART_SIZES[nick] ?? ART_SIZES[DEFAULT_ART_SIZE];
        this._artFallback.icon_size = this._artSize.icon;
        this._applyArtStyle();
    }

    _applyArtStyle() {
        const {size, radius} = this._artSize;
        const image = this._artPath
            ? ` background-image: ${cssUrl(this._artPath)};`
            : '';
        this._artBin.style =
            `width: ${size}px; height: ${size}px; border-radius: ${radius}px;${image}`;
    }

    setPlayer(player) {
        if (this._player === player) {
            this.sync();
            return;
        }

        this._disconnectPlayer();
        this._player = player;

        if (player) {
            this._playerSignals.push(player.connect('changed', () => this.sync()));
            this._playerSignals.push(player.connect('seeked', (_p, position) => {
                this._position = position;
                this._updateSlider();
            }));
        }

        this._currentArtUrl = null;
        this.sync();
        this._refreshPosition();
    }

    _disconnectPlayer() {
        if (this._player) {
            for (const id of this._playerSignals)
                this._player.disconnect(id);
        }
        this._playerSignals = [];
    }

    /** The card only polls Position while it is actually on screen. */
    setActive(active) {
        this._active = active;
        this._equalizer.setActive(active);
        this._updateTimer();
        if (active)
            this._refreshPosition();
    }

    /* Polling exists to move the seek bar. No seek bar on screen, no polling —
     * every tick is a D-Bus round trip. */
    _updateTimer() {
        const wanted = this._active && this._seekBox.visible &&
            this._player?.isPlaying;

        if (wanted && !this._timeoutId) {
            this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
                POSITION_POLL_SECONDS, () => {
                    this._refreshPosition();
                    return GLib.SOURCE_CONTINUE;
                });
        } else if (!wanted && this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }

    _refreshPosition() {
        const player = this._player;
        if (!player)
            return;
        player.getPosition().then(position => {
            /* The D-Bus round trip can outlive a drag starting, the player it
             * was issued for, or the card itself (destroy nulls `_player`) — a
             * late answer from the previous track would otherwise be painted
             * onto this one's slider. */
            if (this._dragging || this._player !== player)
                return;
            this._position = position;
            this._updateSlider();
        });
    }

    _updateSlider() {
        if (this._dragging)
            return;
        const fraction = this._length > 0
            ? Math.min(1, Math.max(0, this._position / this._length))
            : 0;
        this._slider.value = fraction;
        this._updateTimeLabels(this._position);
    }

    _updateTimeLabels(position, length = this._length) {
        this._positionLabel.text = formatTime(position);
        this._remainingLabel.text = `-${formatTime(Math.max(0, length - position))}`;
    }

    /** Drop any painted art and orphan whatever download is in flight. */
    _clearArt() {
        this._artGeneration++;
        this._currentArtUrl = null;
        this._artPath = null;
        this._applyArtStyle();
        this._artFallback.gicon = null;
        this._artFallback.icon_name = 'audio-x-generic-symbolic';
        this._artFallback.opacity = DIM_OPACITY;
        this._artFallback.visible = true;
    }

    /* A real app icon carries its own color and reads as artwork; only the
     * generic symbolic placeholder wants dimming. */
    _setFallbackIcon(player) {
        this._artFallback.gicon = player.appIcon;
        this._artFallback.opacity = player.hasAppIcon ? 255 : DIM_OPACITY;
    }

    _updateArt() {
        const player = this._player;
        const showArt = this._settings.get_boolean('card-show-art');
        this._artBin.visible = showArt;

        /* Forget the current art while hidden, so re-enabling the setting on the
         * same track resolves it again instead of short-circuiting below. */
        if (!showArt || !player) {
            this._clearArt();
            return;
        }

        const url = player.artUrl;
        if (url === this._currentArtUrl) {
            /* The app proxy resolves after the player proxy, so a track with no
             * artwork can still gain a real icon on a later sync. */
            if (this._artFallback.visible)
                this._setFallbackIcon(player);
            return;
        }

        /* Art resolution is async; a newer track must win even if its download
         * finishes first. */
        this._clearArt();
        this._currentArtUrl = url;
        const generation = this._artGeneration;
        this._setFallbackIcon(player);

        if (!url)
            return;

        this._artCache.resolve(url).then(path => {
            if (generation !== this._artGeneration || !path)
                return;
            this._artPath = path;
            this._applyArtStyle();
            this._artFallback.visible = false;
        });
    }

    sync() {
        const player = this._player;

        if (!player) {
            this._titleLabel.text = _('Nothing playing');
            this._subtitleLabel.text = '';
            this._subtitleLabel.visible = false;
            this._seekBox.visible = false;
            this._appButton.visible = false;
            this._backButton.visible = false;
            this._forwardButton.visible = false;
            this._shuffleButton.visible = false;
            this._loopButton.visible = false;
            this._equalizer.visible = false;
            this._equalizer.setPlaying(false);
            this._length = 0;
            this._updateArt();
            this._updateTimer();
            return;
        }

        const title = player.title || _('Unknown title');
        const artist = player.artist;
        const album = player.album;

        this._titleLabel.text = truncate(title, MAX_TITLE_CHARS);
        const subtitle = artist && album && artist !== album
            ? `${artist} — ${album}`
            : artist || album;
        this._subtitleLabel.text = subtitle;
        this._subtitleLabel.visible = !!subtitle;

        this._playButton.child.icon_name = playPauseIconName(player);

        this._equalizer.visible = true;
        this._equalizer.setPlaying(player.isPlaying);

        this._setSensitive(this._prevButton, player.canGoPrevious);
        this._setSensitive(this._nextButton, player.canGoNext);
        this._setSensitive(this._playButton, player.canPlay);

        this._appIcon.gicon = player.appIcon;
        this._appButton.visible = player.canRaise;

        this._length = player.length;
        const showSeek = this._settings.get_boolean('card-show-seek-bar') &&
            this._length > 0;
        this._seekBox.visible = showSeek;
        this._setSensitive(this._slider, player.canSeek);

        /* Skipping needs Seek(); a player without it gets no skip buttons. */
        const showSkip = this._settings.get_boolean('card-show-seek-buttons') &&
            player.canSeek;
        this._backButton.visible = showSkip;
        this._forwardButton.visible = showSkip;

        /* Shuffle and loop are optional MPRIS properties; a player that does
         * not implement them gets no button, whatever the setting says. */
        this._shuffleButton.visible =
            this._settings.get_boolean('card-show-shuffle') && player.canShuffle;
        this._loopButton.visible =
            this._settings.get_boolean('card-show-loop') && player.canLoop;
        this._loopButton.child.icon_name = loopIconName(player.loopStatus);
        setToggleStyle(this._shuffleButton, player.shuffle === true);
        setToggleStyle(this._loopButton,
            player.canLoop && player.loopStatus !== 'None');

        this._updateArt();
        this._updateSlider();
        this._updateTimer();
    }

    /* Setting `reactive` is enough: St maps it to the `:insensitive` pseudo
     * class, which the theme already styles. */
    _setSensitive(actor, sensitive) {
        actor.reactive = sensitive;
    }

    _onDestroy() {
        /* Orphans any in-flight art download: its callback checks the
         * generation and finds it stale. */
        this._artGeneration++;

        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this._seekRefreshId) {
            GLib.Source.remove(this._seekRefreshId);
            this._seekRefreshId = 0;
        }
        this._disconnectPlayer();
        for (const id of this._settingsSignals)
            this._settings.disconnect(id);
        this._settingsSignals = [];
        this._player = null;
    }
});
