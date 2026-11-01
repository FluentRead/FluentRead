---
title: Design system & component previews
description: Explore FluentRead colors, typography, and real Vue components across themes and screen sizes.
---

# Design system & component previews

Explore colors and typography, interact with real selects, switches, and settings cards, and compare light, dark, and built-in skins.

<a class="bv-button bv-primary" href="/storybook/?path=/docs/foundations-colors--docs" target="_blank" rel="noopener noreferrer">Open the component explorer →</a>

## How to use it

1. Choose a section or component in the sidebar and open its documentation or an individual example.
2. Switch themes, skins, or component language in the toolbar. Descriptions and demo text retain their original language.
3. Adjust disabled states, icon sizes, progress, and other parameters in **Controls**.
4. Switch between Popup, Mobile, and Desktop viewports to check wrapping and layout, then interact with a mouse or keyboard.

| Section | Content |
| --- | --- |
| Overview | Explorer introduction |
| Foundations | Theme colors, text contrast, typography, corners, and shadows |
| UI | Selects, switches, collapsible cards, progress, icons, buttons, and dialogs |
| Examples | Real settings-card compositions, including long text and narrow screens |

Previews do not read or change extension settings, call translation services, or download models or fonts. Missing fonts use system fallbacks. Use the extension for complete features.

<details class="guide-details">
<summary>Contributing to the interface</summary>

## Contributing to the interface

Install dependencies and start the explorer from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm storybook
```

Open the address shown in the terminal, usually `http://127.0.0.1:6006`. Examples live in `storybook/`, and configuration in `.storybook/`. Reuse components from `src/ui/components/` and styles from `src/ui/styles/`.

### Cards and information order

- Start settings pages with navigation or content. The sidebar, narrow-screen category, and accessible heading provide the page name.
- Reuse `SettingsGroup`, `SettingsItem`, and `SettingsDisclosure` from `src/features/settings/ui/components/`. Use shared colors and spacing from `src/ui/styles/tokens.css`.
- Keep common settings expanded. Secondary settings can collapse, with setup and failure states visible in the summary. Retain drafts when collapsed; callers still manage requests and saving.
- Keep titles and explanations together, with one primary button per action area. Put technical details in help.
- Task dialogs and confirmations share `src/ui/styles/dialogs.css`: scroll the content inside the window, keep footer actions reachable, and reveal formats or full differences on demand. Cancel always cancels; it never submits an alternative choice.
- Use `settings-controls.css` and an `fr-settings-controls` container for standalone settings controls to retain switch sizes, touch areas, and keyboard focus styles.
- Check dark themes, narrow screens, long text, keyboard focus, and drafts after reopening. Allow primary text to wrap and avoid distracting animations or filters.

Build and check:

```sh
pnpm storybook:typecheck
pnpm docs:build:site
pnpm storybook:check
pnpm docs:check
pnpm docs:preview
```

`docs:build:site` places the explorer in the documentation output’s `storybook/` directory. Preview it from the local docs. GitHub Pages publishes the same artifact.

</details>

## References

The order draws on [Read Frog Storybook](https://storybook.readfrog.app/?path=/docs/foundations-colors--docs). Components and styles use FluentRead’s own Vue, Element Plus, and Vite implementation. See the [Storybook Vue and Vite documentation](https://storybook.js.org/docs/8/get-started/frameworks/vue3-vite) for the tool itself.
