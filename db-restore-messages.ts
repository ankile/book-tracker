import { PROJECT_ID, type MigrationFlags } from './migrate-lib.ts';

interface RestoreMessageOptions {
  file: string;
  flags: Pick<MigrationFlags, 'prod' | 'apply' | 'database'>;
}

interface RestoreCompletionOptions extends RestoreMessageOptions {
  documents: number;
  skipped: number;
}

const RULE = '='.repeat(72);

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function applyCommand({ file, flags }: RestoreMessageOptions): string {
  const argumentsList = [
    'node db-restore.ts',
    shellArgument(file),
    ...(flags.prod ? ['--prod'] : []),
    '--apply',
    ...(flags.database ? [`--database=${shellArgument(flags.database)}`] : []),
  ];
  return argumentsList.join(' ');
}

function targetDescription(flags: RestoreMessageOptions['flags']): string {
  const target = flags.prod ? `PRODUCTION project ${PROJECT_ID}` : 'the Firestore emulator';
  return flags.database ? `${target}, database ${flags.database}` : target;
}

function applyGuidance(options: RestoreMessageOptions): string {
  const confirmation = options.flags.prod
    ? `\nThat command still requires typing ${PROJECT_ID} before any write starts.`
    : '';
  return `To perform this restore, re-run exactly:\n  ${applyCommand(options)}${confirmation}`;
}

export function restoreStartBanner(options: RestoreMessageOptions): string {
  if (options.flags.apply) {
    const confirmation = options.flags.prod
      ? `\nTyped confirmation for ${PROJECT_ID} is required before writes start.`
      : '';
    return [
      RULE,
      'APPLY MODE — WRITES ARE ENABLED',
      `Target: ${targetDescription(options.flags)}`,
      `Snapshot: ${options.file}${confirmation}`,
      RULE,
    ].join('\n');
  }

  const prodReminder = options.flags.prod
    ? '\n--prod selected the production target only. It did NOT enable writes.'
    : '';
  return [
    RULE,
    'DRY RUN ONLY — NOTHING WRITTEN; NOTHING WILL BE WRITTEN',
    `Requested target: ${targetDescription(options.flags)}`,
    `Snapshot selected: ${options.file}${prodReminder}`,
    applyGuidance(options),
    RULE,
  ].join('\n');
}

export function restoreCompletionBanner(options: RestoreCompletionOptions): string {
  const detail = `${options.documents} documents ${options.flags.apply ? 'restored' : 'checked'} ` +
    `from ${options.file} (${options.skipped} togglQueue docs skipped)`;
  if (options.flags.apply) {
    return [
      RULE,
      `APPLY COMPLETE — ${options.documents} DOCUMENTS WRITTEN`,
      detail,
      RULE,
    ].join('\n');
  }
  return [
    RULE,
    'DRY RUN COMPLETE — NOTHING WRITTEN',
    detail,
    'No restore was applied.',
    applyGuidance(options),
    RULE,
  ].join('\n');
}
