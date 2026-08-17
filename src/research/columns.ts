/**
 * The workbook's columns, in one place.
 *
 * Three things used to carry their own copy of this list: `init` wrote a header,
 * `matrix` appended cells positionally, and `readWorkbook` validated against a
 * separate set of known names. They drifted — a scaffolded workbook had no
 * `parallelToolCalls` or `fixture` column at all, so two supported settings were
 * unreachable unless you knew to add the column by hand.
 *
 * Adding a column is now one entry here plus the parsing for it.
 */

/** Every column the reader understands, in the order they are written. */
export const COLUMNS = [
  'id',
  'enabled',
  'task',
  'model',
  'surface',
  'temperature',
  'thinking',
  'memory',
  'resetTools',
  'parallelToolCalls',
  'faults',
  'repeat',
  'fixture',
  'notes',
] as const;

export type Column = (typeof COLUMNS)[number];

/** Without these a row names no episode at all. */
export const REQUIRED_COLUMNS = ['id', 'task', 'model'] as const;

/** `Reset Tools`, `reset_tools` and `resetTools` are the same column. */
export const normalise = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

export const KNOWN_COLUMNS: ReadonlySet<string> = new Set(COLUMNS.map(normalise));
