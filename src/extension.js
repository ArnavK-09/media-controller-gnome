// SPDX-License-Identifier: GPL-2.0-or-later
/* extension.js */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {ArtCache} from './artCache.js';
import {MediaCard} from './mediaCard.js';
import {MprisManager} from './mpris.js';
import {ScrollingLabel} from './scrollingLabel.js';
import {playPauseIconName, seekOffset} from './transport.js';

const ROLE = 'media-controller';

/* `atEnd` positions are appended after everything already in that panel box —
 * for "far right" that means past the quick settings menu. */
const PANEL_POSITIONS = {
    'far-left': {box: 'left', atEnd: false},
    'left': {box: 'left', atEnd: true},
    'center': {box: 'center', atEnd: false},
    'right': {box: 'right', atEnd: false},
    'far-right': {box: 'right', atEnd: true},
};

/* Every key the indicator renders from. Each gets a `changed::` handler that
 * refreshes the cache in _readSettings() and re-syncs. */
const PANEL_KEYS = [
    'show-previous',
    'show-play-pause',
    'show-next',
    'show-seek-backward',
    'show-seek-forward',
    'show-player-icon',
    'show-title',
    'show-artist',
    'panel-text-width',
    'scroll-text',
    'scroll-speed',
    'scroll-direction',
    'scroll-loop',
    'hide-when-inactive',
    'controls-on-left',
];

const MediaIndicator = GObject.registerClass(
class MediaIndicator extends PanelMenu.Button {
    _init(extension, settings, artCache, manager) {
        super._init(0.5, 'Media Controller');

        this._settings = settings;
        this._manager = manager;
        this._orderApplied = null;
        this._readSettings();

        this.add_style_class_name('mc-panel-button');

        this._disableMenuToggle();

        this._box = new St.BoxLayout({
            style_class: 'mc-panel-box',
            orientation: Clutter.Orientation.HORIZONTAL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._box);

        this._buildTextBox();
        this._buildControls();

        this._card = new MediaCard(artCache, settings);
        this._card.connect('activated', () => this.menu.close());
        this._card.connect('open-preferences', () => {
            this.menu.close();
            extension.openPreferences();
        });

        this.menu.box.add_style_class_name('mc-card-menu');
        const item = new PopupMenu.PopupBaseMenuItem({
            activate: false,
            reactive: false,
            can_focus: false,
            style_class: 'mc-card-item',
        });
        item.add_child(this._card);
        this.menu.addMenuItem(item);

        this.menu.connect('open-state-changed', (_menu, open) => {
            this._card.setActive(open);
            if (open)
                this._card.sync();
        });

        this._managerId = this._manager.connect('changed', () => this.sync());

        this._settingsIds = PANEL_KEYS.map(key =>
            this._settings.connect(`changed::${key}`, () => {
                this._readSettings();
                this.sync();
            }));

        this.connect('destroy', () => this._onDestroy());

        this.sync();
    }

    /**
     * sync() runs on every D-Bus property change — several times a second for
     * players that report progress — and each GSettings read marshals a
     * GVariant. The values only move when one of the handlers above fires, so
     * they are read there and cached here.
     */
    _readSettings() {
        const settings = this._settings;
        this._prefs = {
            showPrevious: settings.get_boolean('show-previous'),
            showPlayPause: settings.get_boolean('show-play-pause'),
            showNext: settings.get_boolean('show-next'),
            showSeekBackward: settings.get_boolean('show-seek-backward'),
            showSeekForward: settings.get_boolean('show-seek-forward'),
            showPlayerIcon: settings.get_boolean('show-player-icon'),
            showTitle: settings.get_boolean('show-title'),
            showArtist: settings.get_boolean('show-artist'),
            textWidth: settings.get_int('panel-text-width'),
            scrollText: settings.get_boolean('scroll-text'),
            scrollSpeed: settings.get_int('scroll-speed'),
            scrollRightToLeft: settings.get_string('scroll-direction') === 'right-to-left',
            scrollLoop: settings.get_boolean('scroll-loop'),
            hideWhenInactive: settings.get_boolean('hide-when-inactive'),
            controlsOnLeft: settings.get_boolean('controls-on-left'),
        };
    }

    /**
     * PanelMenu.Button opens its menu from a Clutter.ClickGesture that
     * recognizes on press. Gestures are fed from the capture phase, so the
     * gesture claimed every click before the control buttons nested inside us
     * could see it — pressing a control opened the card and the control itself
     * never emitted `clicked`. We drop the gesture and toggle from vfunc_event
     * instead, where the press can be attributed to the actor it landed on.
     */
    _disableMenuToggle() {
        /* Shells before the gesture port have no ClickGesture at all; there the
         * inherited vfunc_event does the toggling, and our override replaces it. */
        if (!Clutter.ClickGesture)
            return;

        for (const action of this.get_actions()) {
            if (action instanceof Clutter.ClickGesture)
                action.set_enabled(false);
        }
    }

    /* A press anywhere on the indicator opens the card, except on the transport
     * controls, which do their own job instead. Toggling on press rather than
     * release matches every other panel menu in the shell. */
    vfunc_event(event) {
        const type = event.type();
        const isPress = type === Clutter.EventType.BUTTON_PRESS ||
                        type === Clutter.EventType.TOUCH_BEGIN;

        if (isPress && this.menu && !this._isOnControls(event))
            this.menu.toggle();

        return Clutter.EVENT_PROPAGATE;
    }

    /**
     * Hit-test the controls box by geometry. `event.get_source()` is null for
     * pointer events here, and picking would report a disabled control as a
     * miss — which would open the card from a greyed-out button.
     */
    _isOnControls(event) {
        if (!this._controlsBox?.visible)
            return false;

        const [x, y] = event.get_coords();
        const [boxX, boxY] = this._controlsBox.get_transformed_position();
        const [width, height] = this._controlsBox.get_transformed_size();

        return x >= boxX && x < boxX + width &&
               y >= boxY && y < boxY + height;
    }

    _buildTextBox() {
        this._textBox = new St.BoxLayout({
            style_class: 'mc-panel-text',
            orientation: Clutter.Orientation.HORIZONTAL,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._playerIcon = new St.Icon({
            style_class: 'system-status-icon mc-player-icon',
            icon_size: 16,
        });
        this._label = new ScrollingLabel('mc-panel-label');

        this._textBox.add_child(this._playerIcon);
        this._textBox.add_child(this._label);
        this._box.add_child(this._textBox);
    }

    _buildControls() {
        this._controlsBox = new St.BoxLayout({
            style_class: 'mc-panel-controls',
            orientation: Clutter.Orientation.HORIZONTAL,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._prevButton = this._panelButton('media-skip-backward-symbolic',
            () => this._manager.activePlayer?.previous());
        this._backButton = this._panelButton('media-seek-backward-symbolic',
            () => this._skip(-1));
        this._playButton = this._panelButton('media-playback-start-symbolic',
            () => this._manager.activePlayer?.playPause());
        this._forwardButton = this._panelButton('media-seek-forward-symbolic',
            () => this._skip(1));
        this._nextButton = this._panelButton('media-skip-forward-symbolic',
            () => this._manager.activePlayer?.next());

        this._controlsBox.add_child(this._prevButton);
        this._controlsBox.add_child(this._backButton);
        this._controlsBox.add_child(this._playButton);
        this._controlsBox.add_child(this._forwardButton);
        this._controlsBox.add_child(this._nextButton);
        this._box.add_child(this._controlsBox);
    }

    /** @param {number} direction -1 to rewind, 1 to skip ahead */
    _skip(direction) {
        this._manager.activePlayer?.seek(seekOffset(this._settings, direction));
    }

    _panelButton(iconName, onClick) {
        const button = new St.Button({
            style_class: 'mc-panel-control',
            can_focus: true,
            /* Without this the button fills the panel's height and the round
             * hover fill stretches into a slab. */
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                icon_name: iconName,
                style_class: 'system-status-icon',
                icon_size: 16,
            }),
        });
        button.connect('clicked', onClick);
        return button;
    }

    /** The full text; the label itself truncates or scrolls it. */
    _panelText(player) {
        const parts = [];
        if (this._prefs.showTitle && player.title)
            parts.push(player.title);
        if (this._prefs.showArtist && player.artist)
            parts.push(player.artist);
        return parts.join(' · ');
    }

    sync() {
        const player = this._manager.activePlayer;
        const prefs = this._prefs;
        this._card.setPlayer(player);

        if (!player) {
            /* Drop the text before hiding: a scrolling label left with content
             * keeps its animation running against an actor nobody can see. */
            this._label.setText('');

            if (prefs.hideWhenInactive) {
                if (this.menu.isOpen)
                    this.menu.close();
                this.container.visible = false;
                return;
            }

            /* Idle placeholder: just the generic media icon, no controls. */
            this.container.visible = true;
            this._label.visible = false;
            this._playerIcon.icon_name = 'audio-x-generic-symbolic';
            this._playerIcon.visible = true;
            this._textBox.visible = true;
            this._controlsBox.visible = false;
            this._applyOrder();
            return;
        }

        this.container.visible = true;

        const text = this._panelText(player);
        this._label.setWidth(prefs.textWidth);
        this._label.setScrolling(prefs.scrollText, prefs.scrollSpeed,
            prefs.scrollRightToLeft, prefs.scrollLoop);
        this._label.setText(text);
        this._label.visible = text.length > 0;

        this._playerIcon.visible = prefs.showPlayerIcon;
        if (this._playerIcon.visible)
            this._playerIcon.gicon = player.appIcon;
        this._textBox.visible = this._label.visible || this._playerIcon.visible;

        this._prevButton.visible = prefs.showPrevious;
        this._playButton.visible = prefs.showPlayPause;
        this._nextButton.visible = prefs.showNext;

        /* Skipping needs Seek(); a player without it gets no skip buttons. */
        this._backButton.visible = player.canSeek && prefs.showSeekBackward;
        this._forwardButton.visible = player.canSeek && prefs.showSeekForward;

        this._controlsBox.visible = this._prevButton.visible ||
            this._playButton.visible || this._nextButton.visible ||
            this._backButton.visible || this._forwardButton.visible;

        this._playButton.child.icon_name = playPauseIconName(player);

        this._setSensitive(this._prevButton, player.canGoPrevious);
        this._setSensitive(this._nextButton, player.canGoNext);
        this._setSensitive(this._playButton, player.canPlay);

        this._applyOrder();
    }

    _setSensitive(actor, sensitive) {
        actor.reactive = sensitive;
        actor.opacity = sensitive ? 255 : 100;
    }

    /* set_child_at_index() re-inserts the actor and queues a relayout even when
     * the index does not move, so only act on a real change. */
    _applyOrder() {
        const controlsFirst = this._prefs.controlsOnLeft;
        if (controlsFirst === this._orderApplied)
            return;

        this._orderApplied = controlsFirst;
        this._box.set_child_at_index(this._controlsBox, controlsFirst ? 0 : 1);
    }

    _onDestroy() {
        if (this._managerId)
            this._manager.disconnect(this._managerId);
        this._managerId = 0;

        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
    }
});

export default class MediaControllerExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._artCache = new ArtCache();
        this._manager = new MprisManager();
        this._indicator = new MediaIndicator(this, this._settings, this._artCache, this._manager);

        const {box, index} = this._placement();
        Main.panel.addToStatusArea(ROLE, this._indicator, index, box);

        /* addToStatusArea unconditionally shows the container, which would undo
         * the "hide when nothing is playing" state chosen during construction. */
        this._indicator.sync();

        this._positionId = this._settings.connect('changed::panel-position',
            () => this._reposition());
    }

    _panelBoxes() {
        return {
            left: Main.panel._leftBox,
            center: Main.panel._centerBox,
            right: Main.panel._rightBox,
        };
    }

    /* Resolve the setting to a concrete box and child index. The index is
     * computed rather than passed as -1 so the append case is unambiguous. */
    _placement() {
        const key = this._settings.get_string('panel-position');
        const {box, atEnd} = PANEL_POSITIONS[key] ?? PANEL_POSITIONS['right'];
        const boxActor = this._panelBoxes()[box];
        return {
            box,
            boxActor,
            index: atEnd ? boxActor.get_n_children() : 0,
        };
    }

    /* Re-parenting keeps the indicator's statusArea role and menu registration
     * intact, unlike destroying and re-adding it. */
    _reposition() {
        if (!this._indicator)
            return;

        const container = this._indicator.container;
        container.get_parent()?.remove_child(container);

        /* Recompute after the removal so the end index excludes ourselves. */
        const {boxActor, index} = this._placement();
        boxActor.insert_child_at_index(container, index);
    }

    disable() {
        if (this._positionId)
            this._settings.disconnect(this._positionId);
        this._positionId = 0;

        this._indicator?.destroy();
        this._indicator = null;

        this._manager?.destroy();
        this._manager = null;

        this._artCache?.destroy();
        this._artCache = null;

        this._settings = null;
    }
}
