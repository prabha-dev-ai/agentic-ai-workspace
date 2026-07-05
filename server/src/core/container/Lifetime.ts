// How long a resolved instance lives:
// - Singleton: created once (lazily, on first resolution), then shared.
// - Transient: created fresh on every resolution.
//
// A const-object union instead of a TS enum: Node's native type stripping
// only erases types, and enums are runtime constructs it cannot erase.
export const Lifetime = {
  Singleton: 'singleton',
  Transient: 'transient',
} as const;

export type Lifetime = (typeof Lifetime)[keyof typeof Lifetime];
