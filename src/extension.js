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

const ROLE = 'media-controller';

const US_PER_SECOND = 1000000;

/* `atEnd` positions are appended after everything already in that panel box —
 * for "far right" that means past the quick settings menu. */
const PANEL_POSITIONS = {
    'far-left': {box: 'left', atEnd: false},
    'left': {box: 'left', atEnd: true},
    'center': {box: 'center', atEnd: false},
    'right': {box: 'right', atEnd: false},
    'far-right': {box: 'right', atEnd: true},
};

const MediaIndicator = GObject.registerClass(
class MediaIndicator extends PanelMenu.Button {
    _init(extension, settings, artCache, manager) {
        super._init(0.5, 'Media Controller');

        this._settings = settings;
        this._manager = manager;

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

        this._settingsIds = [
            'changed::show-previous',
            'changed::show-play-pause',
            'changed::show-next',
            'changed::show-seek-backward',
            'changed::show-seek-forward',
            'changed::show-player-icon',
            'changed::show-title',
            'changed::show-artist',
            'changed::panel-text-width',
            'changed::scroll-text',
            'changed::scroll-speed',
            'changed::hide-when-inactive',
            'changed::controls-on-left',
        ].map(key => this._settings.connect(key, () => this.sync()));

        this.connect('destroy', () => this._onDestroy());

        this.sync();
    }

    /**
     * PanelMenu.Button opens its menu from a Clutter.ClickGesture that
     * recognizes on press. Gestures are fed from the capture phase, so the
     * gesture claims the sequence and cancels the St.Button gestures of the
     * controls nested inside us — the card would open and the control would
     * never emit `clicked`. Turning it off lets each child own its own clicks;
     * the text box below takes over opening the card.
     */
    _disableMenuToggle() {
        /* Shells before the gesture port have no ClickGesture at all. */
        if (!Clutter.ClickGesture)
            return;

        for (const action of this.get_actions()) {
            if (action instanceof Clutter.ClickGesture)
                action.set_enabled(false);
        }
    }

    /* Shells that predate the gesture port toggle the menu from vfunc_event
     * instead. Swallowing it there is the equivalent of the above. */
    vfunc_event(_event) {
        return Clutter.EVENT_PROPAGATE;
    }

    _buildTextBox() {
        const content = new St.BoxLayout({
            style_class: 'mc-panel-text',
            orientation: Clutter.Orientation.HORIZONTAL,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._playerIcon = new St.Icon({
            style_class: 'system-status-icon mc-player-icon',
            icon_size: 16,
        });
        this._label = new ScrollingLabel('mc-panel-label');

        content.add_child(this._playerIcon);
        content.add_child(this._label);

        this._textBox = new St.Button({
            style_class: 'mc-panel-text-button',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: content,
        });
        this._textBox.connect('clicked', () => this.menu.toggle());
        this._box.add_child(this._textBox);
    }

    _buildControls() {
        this._controlsBox = new St.BoxLayout({
            style_class: 'mc-panel-controls',
            orientation: Clutter.Orientation.HORIZONTAL,
            y_align: Clutter.ActorAlign.CENTER,
        });

        /* St.Button consumes the button-press event, so clicking a control does
         * not also toggle the menu the way clicking the label does. */
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
        const step = this._settings.get_int('seek-step-seconds') * US_PER_SECOND;
        this._manager.activePlayer?.seek(direction * step);
    }

    _panelButton(iconName, onClick) {
        const button = new St.Button({
            style_class: 'mc-panel-control',
            can_focus: true,
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
        if (this._settings.get_boolean('show-title') && player.title)
            parts.push(player.title);
        if (this._settings.get_boolean('show-artist') && player.artist)
            parts.push(player.artist);
        return parts.join(' · ');
    }

    sync() {
        const player = this._manager.activePlayer;
        this._card.setPlayer(player);

        if (!player) {
            if (this._settings.get_boolean('hide-when-inactive')) {
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
        this._label.setWidth(this._settings.get_int('panel-text-width'));
        this._label.setScrolling(this._settings.get_boolean('scroll-text'),
            this._settings.get_int('scroll-speed'));
        this._label.setText(text);
        this._label.visible = text.length > 0;

        this._playerIcon.visible = this._settings.get_boolean('show-player-icon');
        if (this._playerIcon.visible)
            this._playerIcon.gicon = player.appIcon;
        this._textBox.visible = this._label.visible || this._playerIcon.visible;

        this._prevButton.visible = this._settings.get_boolean('show-previous');
        this._playButton.visible = this._settings.get_boolean('show-play-pause');
        this._nextButton.visible = this._settings.get_boolean('show-next');

        /* Skipping needs Seek(); a player without it gets no skip buttons. */
        this._backButton.visible = player.canSeek &&
            this._settings.get_boolean('show-seek-backward');
        this._forwardButton.visible = player.canSeek &&
            this._settings.get_boolean('show-seek-forward');

        this._controlsBox.visible = this._prevButton.visible ||
            this._playButton.visible || this._nextButton.visible ||
            this._backButton.visible || this._forwardButton.visible;

        this._playButton.child.icon_name = player.isPlaying
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';

        this._setSensitive(this._prevButton, player.canGoPrevious);
        this._setSensitive(this._nextButton, player.canGoNext);
        this._setSensitive(this._playButton, player.canPlay);

        this._applyOrder();
    }

    _setSensitive(actor, sensitive) {
        actor.reactive = sensitive;
        actor.opacity = sensitive ? 255 : 100;
    }

    _applyOrder() {
        const controlsFirst = this._settings.get_boolean('controls-on-left');
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
