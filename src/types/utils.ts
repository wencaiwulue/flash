import type { ReadonlyDeep } from 'type-fest'

export type DeepImmutable<T> = ReadonlyDeep<T>

export type Permutations<T> = readonly T[]
