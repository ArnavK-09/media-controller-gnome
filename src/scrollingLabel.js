// SPDX-License-Identifier: GPL-2.0-or-later
/* scrollingLabel.js
 *
 * The panel's track label. It occupies a fixed width and either ellipsizes
 * text that does not fit or scrolls it, carousel style: the text is drawn
 * twice so the tail of one copy is still on screen while the head of the next
 * scrolls in.
 */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

/* Blank space between the two copies, so the loop reads as a gap rather than
 * the title running straight into itself. */
const GAP = 32;

/* Long enough to read the beginning of the title before it moves off. */
const PAUSE_MS = 1200;

export const ScrollingLabel = GObject.registerClass(
class ScrollingLabel extends St.Widget {
    _init(styleClass) {
        super._init({
            /* FixedLayout hands each child its natural size, so the copies keep
             * their full text width no matter how narrow the window gets. */
            layout_manager: new Clutter.FixedLayout(),
            clip_to_allocation: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._text = '';
        this._width = 200;
        this._scrolling = false;
        this._speed = 30;

        /* The scroll distance currently animating; 0 when nothing is moving. */
        this._distance = 0;

        this._box = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style: `spacing: ${GAP}px;`,
        });
        this._first = new St.Label({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
        this._second = new St.Label({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
        this._first.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._second.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._second.visible = false;
        this._box.add_child(this._first);
        this._box.add_child(this._second);
        this.add_child(this._box);

        /* Widths measured before the theme resolves the font are wrong, and the
         * font can change later (theme switch, font-size change). */
        this._styleId = this._first.connect('style-changed', () => this._update());

        this.connect('destroy', () => this._onDestroy());
    }

    /** @param {string} text */
    setText(text) {
        if (text === this._text)
            return;
        this._text = text;
        this._update(true);
    }

    /** @param {number} width the fixed width of the label, in pixels */
    setWidth(width) {
        if (width === this._width)
            return;
        this._width = width;
        this._update(true);
    }

    /**
     * @param {boolean} enabled
     * @param {number} speed pixels per second
     */
    setScrolling(enabled, speed) {
        if (enabled === this._scrolling && speed === this._speed)
            return;
        this._scrolling = enabled;
        this._speed = speed;
        this._update(true);
    }

    /* Preferred width of the text in this label's font. */
    _textWidth() {
        return this._first.clutter_text.get_preferred_width(-1)[1];
    }

    /** @param {boolean} force restart the animation even if the geometry matches */
    _update(force = false) {
        this._first.text = this._text;
        this.set_width(this._width);

        const fullWidth = this._textWidth();
        if (!this._scrolling || fullWidth <= this._width) {
            this._showStatic();
            return;
        }

        const distance = fullWidth + GAP;
        /* A style-changed that did not actually move anything must not restart
         * the animation, or the title would jump back to the start. */
        if (!force && this._distance === distance)
            return;

        this._stop();
        this._first.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        /* Let the copies run to their full width and off the clipped edge. */
        this._first.set_width(-1);
        this._second.text = this._text;
        this._second.visible = true;
        this._distance = distance;
        this._start();
    }

    /* Scrolling off, or the text already fits: one ellipsized copy. Pinning it
     * to the window is what makes Pango add the ellipsis — left at its natural
     * width it would simply be cut off by the clip. */
    _showStatic() {
        this._stop();
        this._first.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._first.set_width(this._width);
        this._second.visible = false;
        this._distance = 0;
    }

    _start() {
        /* Respect the accessibility setting; the ellipsized copy stays readable. */
        if (!St.Settings.get().enable_animations) {
            this._showStatic();
            return;
        }
        this._loop();
    }

    /* One pass shifts the box by exactly one copy plus the gap, which puts the
     * second copy where the first was — so resetting to 0 is invisible. */
    _loop() {
        this._box.translation_x = 0;
        this._box.ease({
            translation_x: -this._distance,
            duration: (this._distance / Math.max(1, this._speed)) * 1000,
            delay: PAUSE_MS,
            mode: Clutter.AnimationMode.LINEAR,
            onComplete: () => this._loop(),
        });
    }

    _stop() {
        this._box.remove_all_transitions();
        this._box.translation_x = 0;
    }

    _onDestroy() {
        this._stop();
        if (this._styleId)
            this._first.disconnect(this._styleId);
        this._styleId = 0;
    }
});
