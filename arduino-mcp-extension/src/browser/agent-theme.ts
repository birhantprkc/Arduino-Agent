/**
 * Arduino Agent's colors: Arduino's light and dark themes with their teal moved
 * to the indigo of the app icon, so the IDE looks like its own app.
 *
 * The themes keep Arduino's ids (`arduino-theme`, `arduino-theme-dark`): the
 * vendored settings dialog lists exactly those as the built-in Light/Dark, and
 * users' saved `workbench.colorTheme` keeps working. Only the content changes,
 * computed from Arduino's theme JSON at registration so upstream theme updates
 * carry over:
 *
 * - accents (teal hues, chroma >= 0.05 in OKLCH) take the icon's indigo hue,
 *   with somewhat more chroma, at their original lightness;
 * - neutrals with a slight teal tint keep their lightness and tiny chroma but
 *   lean toward indigo instead of teal;
 * - everything else (whites, greys, the yellow/red highlights) is unchanged.
 *
 * Keeping lightness keeps the contrast Arduino tuned. A few rules in
 * arduino-ide-extension's CSS hardcode teal; AGENT_THEME_CSS overrides them in
 * terms of the theme's branding color.
 */

import { injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { ColorContribution } from '@theia/core/lib/browser/color-application-contribution';
import { ColorRegistry } from '@theia/core/lib/browser/color-registry';
import { MonacoThemingService } from 'arduino-ide-extension/lib/browser/theia/monaco/monaco-theming-service';
import { ArduinoThemes } from 'arduino-ide-extension/lib/browser/theia/core/theming';
import { toAgentPalette } from './agent-palette';

/** The inherited Theia method used below (the vendored base class is untyped here). */
interface ParsedThemeRegistry {
  registerParsedTheme(theme: { id: string; label: string; uiTheme: 'vs' | 'vs-dark'; json: unknown }): unknown;
}

@injectable()
export class AgentMonacoThemingService extends MonacoThemingService {
  /** Replaces arduino-ide-extension's registration (called from its restore()). */
  registerArduinoThemes(): void {
    const { light, dark } = ArduinoThemes;
    const registry = this as unknown as ParsedThemeRegistry;
    registry.registerParsedTheme({
      id: light.id,
      label: light.label,
      uiTheme: 'vs',
      json: toAgentPalette(require('arduino-ide-extension/src/browser/data/default.color-theme.json')),
    });
    registry.registerParsedTheme({
      id: dark.id,
      label: dark.label,
      uiTheme: 'vs-dark',
      json: toAgentPalette(require('arduino-ide-extension/src/browser/data/dark.color-theme.json')),
    });
  }
}

/**
 * Registers `arduino.branding.primary`/`secondary`. Arduino's themes set them and
 * its CSS uses `var(--theia-arduino-branding-primary)` (boards dialog, library and
 * board lists, serial monitor scrollbar, progress bar), but upstream never
 * registers them, so the variable was undefined and those accents never showed.
 * Also installs the CSS overrides for the teal hardcoded in arduino-ide-extension's
 * stylesheets.
 */
@injectable()
export class AgentThemeStyles implements FrontendApplicationContribution, ColorContribution {
  registerColors(colors: ColorRegistry): void {
    colors.register(
      {
        id: 'arduino.branding.primary',
        defaults: { light: '#5d64c6', dark: '#757ff4', hcLight: 'focusBorder', hcDark: 'focusBorder' },
        description: 'Arduino Agent accent color (links, highlights, the serial monitor scrollbar).',
      },
      {
        id: 'arduino.branding.secondary',
        defaults: { light: '#bfc3d2', dark: '#bfc3d2', hcLight: 'foreground', hcDark: 'foreground' },
        description: 'Arduino Agent secondary branding color.',
      }
    );
  }

  initialize(): void {
    const style = document.createElement('style');
    style.id = 'arduino-agent-theme';
    style.textContent = AGENT_THEME_CSS;
    document.head.appendChild(style);
  }
}

const brand = (percent: number) =>
  `color-mix(in srgb, var(--theia-arduino-branding-primary) ${percent}%, transparent)`;

const AGENT_THEME_CSS = `
:root {
  --arduino-shadow-focus: 0 0 0 3px ${brand(25)};
}
#theia-statusBar .area .element.arduino-selected-port,
#theia-statusBar .area .element.arduino-selected-board {
  background: ${brand(10)};
}
#theia-statusBar .area .element.arduino-selected-port:hover,
#theia-statusBar .area .element.arduino-selected-board:hover {
  background: ${brand(20)};
}
.p-Widget.dialogOverlay .dialogBlock {
  border-color: ${brand(10)};
}
.component-list-item {
  border-bottom-color: ${brand(8)};
}
`;
