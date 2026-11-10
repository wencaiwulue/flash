export function privatePackageUnavailable(packageName: string): Error {
  return new Error(
    `${packageName} is unavailable in this external build. The private package is required to use this feature.`,
  )
}
