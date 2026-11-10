export async function rollback(
  _target?: string,
  _options?: { list?: boolean; dryRun?: boolean; safe?: boolean },
): Promise<never> {
  throw new Error('claude rollback is unavailable in this build')
}
