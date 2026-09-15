declare var Static: {
  SQUARESPACE_CONTEXT?: unknown;
  [key: string]: unknown;
};

interface Window {
  Static?: typeof Static;
}
