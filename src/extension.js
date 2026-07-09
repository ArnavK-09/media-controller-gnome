// SPDX-License-Identifier: GPL-2.0-or-later
/* extension.js */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {ArtCache} from './artCache.js';
import {MediaCard} from './mediaCard.js';
import {MprisManager} from './mpris.js';

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

function truncate(text, maxLength) {
    if (text.length <= maxLength)
        return text;
    return `${text.substring(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

const MediaIndicator = GObject.registerClass(
class MediaIndicator extends PanelMenu.Button {
    _init(extension, settings, artCache, manager) {
        super._init(0.5, 'Media Controller');

        this._settings = settings;
        this._manager = manager;

        this.add_style_class_name('mc-panel-button');

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
            'changed::show-player-icon',
            'changed::show-title',
            'changed::show-artist',
            'changed::max-text-length',
            'changed::hide-when-inactive',
            'changed::controls-on-left',
        ].map(key => this._settings.connect(key, () => this.sync()));

        this.connect('destroy', () => this._onDestroy());

        this.sync();
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
        this._label = new St.Label({
            style_class: 'mc-panel-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;

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

        /* St.Button consumes the button-press event, so clicking a control does
         * not also toggle the menu the way clicking the label does. */
        this._prevButton = this._panelButton('media-skip-backward-symbolic',
            () => this._manager.activePlayer?.previous());
        this._playButton = this._panelButton('media-playback-start-symbolic',
            () => this._manager.activePlayer?.playPause());
        this._nextButton = this._panelButton('media-skip-forward-symbolic',
            () => this._manager.activePlayer?.next());

        this._controlsBox.add_child(this._prevButton);
        this._controlsBox.add_child(this._playButton);
        this._controlsBox.add_child(this._nextButton);
        this._box.add_child(this._controlsBox);
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

    _panelText(player) {
        const parts = [];
        if (this._settings.get_boolean('show-title') && player.title)
            parts.push(player.title);
        if (this._settings.get_boolean('show-artist') && player.artist)
            parts.push(player.artist);
        if (parts.length === 0)
            return '';
        return truncate(parts.join(' · '), this._settings.get_int('max-text-length'));
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
        this._label.text = text;
        this._label.visible = text.length > 0;

        this._playerIcon.visible = this._settings.get_boolean('show-player-icon');
        if (this._playerIcon.visible)
            this._playerIcon.gicon = player.appIcon;
        this._textBox.visible = this._label.visible || this._playerIcon.visible;

        this._prevButton.visible = this._settings.get_boolean('show-previous');
        this._playButton.visible = this._settings.get_boolean('show-play-pause');
        this._nextButton.visible = this._settings.get_boolean('show-next');
        this._controlsBox.visible =
            this._prevButton.visible || this._playButton.visible || this._nextButton.visible;

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
