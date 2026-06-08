export function formatCliError(error: unknown): string {
  if (error instanceof AggregateError) {
    const nestedErrors = error.errors.map((nestedError, index) => `  ${index + 1}. ${formatCliError(nestedError)}`).join('\n');
    return `Error: ${error.message}\n${nestedErrors}`;
  }

  if (error instanceof Error) {
    if (isDebugMode() && error.stack !== undefined) return error.stack;
    return `Error: ${error.message}`;
  }

  return `Error: ${String(error)}`;
}

function isDebugMode(): boolean {
  const debugValue = process.env['DEBUG'] ?? process.env['COLLECTOR_DEBUG'];
  return debugValue !== undefined && debugValue !== '' && debugValue !== '0' && debugValue.toLowerCase() !== 'false';
}
