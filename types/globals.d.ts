declare var Static: {
  SQUARESPACE_CONTEXT?: unknown;
  COOKIE_BANNER_CAPABLE?: boolean;
  [key: string]: unknown;
};

declare var SQUARESPACE_ROLLUPS: Record<string, { js?: string[]; css?: string[] }>;

declare var dataLayer: unknown[];

declare var Ecwid: {
  init(): void;
  destroy(): void;
};

declare function ecwid_onBodyDone(): void;

interface Window {
  Static?: typeof Static;
  ecwid_nocssrewrite?: boolean;
  ecwid_script_defer?: boolean;
  ecwid_dynamic_widgets?: boolean;
  css_selectors_prefix?: string;
  _xnext_initialization_scripts?: Array<{ widgetType: string; id: string; arg: string[] }>;
}
