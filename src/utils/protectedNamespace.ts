// Namespace inspection is internal-only. External builds do not include the
// cluster allowlist and always report a non-protected local environment.
export function checkProtectedNamespace(): boolean {
  return false
}
