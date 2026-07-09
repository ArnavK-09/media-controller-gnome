---
name: gnome-extension-developer
description: Use this skill when writing, debugging, or reviewing GNOME Shell extension code (GJS, ESM metadata, and GSettings schemas).
---

# GNOME Shell Extension Developer Playbook

You are an expert GNOME Shell Extension developer. Follow these exact technical paradigms for GNOME Shell development.

## 1. Extension Architecture (Modern GJS ESM)

Every GNOME Shell extension requires these core structural files:

- `metadata.json`: Must include `uuid`, `name`, `description`, and explicit compatibility targets (e.g., `"shell-version": ["45", "46", "47", "48"]`).
- `extension.js`: Must export an default class matching the GNOME ESM interface:

  ```javascript
  import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

  export default class MyExtension extends Extension {
    enable() {
      // Initialize UI elements, inject to top bar, bind keys
    }

    disable() {
      // Absolute requirement: Clean up EVERY UI addition, object, and signal binding
    }
  }
  ```

## 2. Strict Implementation Rules

- **UI Injections**: Use `imports.gi.St` (or `gi://St` in modern environments) for Clutter-based UI components.
- **Memory Leaks**: All signals connected using `.connect()` must be disconnected via `.disconnect()` in the `disable()` phase.
- **Settings**: Store user preferences via GSettings. Compile schemas using `glib-compile-schemas schemas/`.

## 3. Workflow & Local Debugging Command Sequencer

When requested to test or run the extension locally, execute these steps:

1. Target the local extension path: `~/.local/share/gnome-shell/extensions/<uuid>`
2. Compile settings: `glib-compile-schemas schemas/`
3. Reload Environment: Instruct user to use Looking Glass (`Alt+F2`, type `lg`) or restart Wayland/X11 session.
4. Enable extension: `gnome-extensions enable <uuid>`
