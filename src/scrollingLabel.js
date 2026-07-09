// SPDX-License-Identifier: GPL-2.0-or-later
/* scrollingLabel.js
 *
 * A panel label that either ellipsizes long text or scrolls it past a fixed
 * window, carousel style: the text is drawn twice so the tail of one copy is
 * still on screen while the head of the next scrolls in.
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

/** @param {string} text @param {number} maxLength */
export function truncate(text, maxLength) {
    if (text.length <= maxLength)
        return text;
    return `${text.substring(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

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
        this._maxChars = 28;
        this._scrolling = false;
        this._speed = 30;

        /* Measured in _update(); -1 means "not scrolling, natural width". */
        this._windowWidth = -1;
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

    /**
     * @param {string} text full, untruncated text
     * @param {number} maxChars how much of it stays visible at once
     */
    setText(text, maxChars) {
        if (text === this._text && maxChars === this._maxChars)
            return;
        this._text = text;
        this._maxChars = maxChars;
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

    /* Preferred width of `text` in this label's font. Swapping the text back
     * before returning keeps it invisible: nothing repaints mid-function. */
    _measure(text) {
        const clutterText = this._first.clutter_text;
        const saved = clutterText.text;
        clutterText.text = text;
        const [, natural] = clutterText.get_preferred_width(-1);
        clutterText.text = saved;
        return natural;
    }

    /** @param {boolean} force restart the animation even if the geometry matches */
    _update(force = false) {
        if (!this._scrolling) {
            this._stop();
            this._first.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            this._first.text = truncate(this._text, this._maxChars);
            this._second.visible = false;
            this._windowWidth = -1;
            this.set_width(-1);
            return;
        }

        this._first.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._first.text = this._text;
        this._second.text = this._text;

        const fullWidth = this._measure(this._text);
        const windowWidth = this._measure(this._text.slice(0, this._maxChars));

        /* Text that already fits is just a plain label. */
        if (fullWidth <= windowWidth) {
            this._stop();
            this._second.visible = false;
            this._windowWidth = -1;
            this.set_width(-1);
            return;
        }

        const distance = fullWidth + GAP;
        /* A style-changed that did not actually move anything must not restart
         * the animation, or the title would jump back to the start. */
        if (!force && this._windowWidth === windowWidth && this._distance === distance)
            return;

        this._stop();
        this._second.visible = true;
        this._windowWidth = windowWidth;
        this._distance = distance;
        this.set_width(windowWidth);
        this._start();
    }

    _start() {
        /* Respect the accessibility setting; the ellipsized copy stays readable. */
        if (!St.Settings.get().enable_animations) {
            this._first.clutter_text.ellipsize = Pango.EllipsizeMode.END;
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
