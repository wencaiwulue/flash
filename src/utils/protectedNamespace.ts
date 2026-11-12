import { readFileSync } from 'fs'

const DEFAULT_NAMESPACE_PATH =
  '/var/run/secrets/kubernetes.io/serviceaccount/namespace'

function isTruthy(value: string | undefined): boolean {
  return (
    value !== undefined &&
    ['1', 'true', 'yes', 'on'].includes(value.toLowerCase().trim())
  )
}

function getAllowedNamespaces(): Set<string> {
  return new Set(
    (process.env.CLAUDE_CODE_ALLOWED_NAMESPACES ?? '')
      .split(',')
      .map(namespace => namespace.trim())
      .filter(namespace => namespace.length > 0),
  )
}

/**
 * Conservatively detects managed Kubernetes/COO environments for telemetry.
 * An exact allowlist match is unprotected; unknown namespaces, missing or
 * unreadable namespace data, and malformed signals are protected. With no
 * environment signals at all, this is a local process and returns false.
 */
export function checkProtectedNamespace(): boolean {
  if (isTruthy(process.env.COO_RUNNING_ON_HOMESPACE)) {
    return false
  }

  const configuredNamespace =
    process.env.CLAUDE_CODE_KUBERNETES_NAMESPACE ??
    process.env.KUBERNETES_NAMESPACE ??
    process.env.COO_NAMESPACE
  const namespacePath = process.env.CLAUDE_CODE_KUBERNETES_NAMESPACE_PATH
  const hasEnvironmentSignal =
    configuredNamespace !== undefined ||
    namespacePath !== undefined ||
    process.env.KUBERNETES_SERVICE_HOST !== undefined ||
    process.env.KUBERNETES_SERVICE_PORT !== undefined ||
    process.env.COO_RUNNING_ON_HOMESPACE !== undefined

  if (!hasEnvironmentSignal) {
    return false
  }

  if (configuredNamespace !== undefined) {
    const namespace = configuredNamespace.trim()
    return namespace.length === 0 || !getAllowedNamespaces().has(namespace)
  }

  try {
    const namespace = readFileSync(
      namespacePath || DEFAULT_NAMESPACE_PATH,
      'utf8',
    ).trim()
    return namespace.length === 0 || !getAllowedNamespaces().has(namespace)
  } catch {
    // A Kubernetes signal without readable namespace data is ambiguous. Fail
    // safe rather than accidentally reporting a protected workload as local.
    return true
  }
}
