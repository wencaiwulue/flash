export async function installPrepareCommitMsgHook(
  _worktreePath: string,
  _hooksDirectory?: string,
): Promise<void> {
  throw new Error(
    'Commit-attribution hook installation is unavailable in this external build.',
  )
}
