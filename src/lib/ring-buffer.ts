/**
 * Fixed-capacity, immutable ring buffer.
 *
 * Used for per-monitor heartbeat history in the Zustand stores: realtime pushes a beat, the
 * oldest beat falls off once `capacity` is reached. Every mutation returns a new instance so
 * store subscribers re-render on reference change; the backing array is small (100 beats by
 * default) so copying is cheaper than the bookkeeping a shared mutable buffer would need.
 */
export class RingBuffer<T> {
  readonly capacity: number
  private readonly items: readonly T[]

  private constructor(capacity: number, items: readonly T[]) {
    this.capacity = capacity
    this.items = items
  }

  /** Empty buffer that keeps the latest `capacity` items. */
  static create<T>(capacity: number): RingBuffer<T> {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`RingBuffer capacity must be a positive integer, got ${capacity}`)
    }
    return new RingBuffer<T>(capacity, [])
  }

  /** Buffer seeded from an array ordered oldest → newest; keeps the newest `capacity` items. */
  static from<T>(items: readonly T[], capacity: number): RingBuffer<T> {
    const buffer = RingBuffer.create<T>(capacity)
    return new RingBuffer<T>(capacity, items.slice(-buffer.capacity))
  }

  get size(): number {
    return this.items.length
  }

  get isEmpty(): boolean {
    return this.items.length === 0
  }

  get isFull(): boolean {
    return this.items.length >= this.capacity
  }

  /** Append one item, evicting the oldest when full. Returns a new buffer. */
  push(item: T): RingBuffer<T> {
    const next =
      this.items.length >= this.capacity
        ? [...this.items.slice(this.items.length - this.capacity + 1), item]
        : [...this.items, item]
    return new RingBuffer<T>(this.capacity, next)
  }

  /** Append several items (oldest → newest). Returns a new buffer. */
  pushMany(items: readonly T[]): RingBuffer<T> {
    if (items.length === 0) return this
    return RingBuffer.from([...this.items, ...items], this.capacity)
  }

  /** Oldest → newest snapshot. The returned array is a stable reference until the next push. */
  toArray(): readonly T[] {
    return this.items
  }

  /** Newest item or `undefined`. */
  last(): T | undefined {
    return this.items[this.items.length - 1]
  }

  /** Oldest item or `undefined`. */
  first(): T | undefined {
    return this.items[0]
  }

  /** The newest `count` items, oldest → newest. */
  tail(count: number): readonly T[] {
    if (count <= 0) return []
    return this.items.slice(-count)
  }

  clear(): RingBuffer<T> {
    return this.items.length === 0 ? this : new RingBuffer<T>(this.capacity, [])
  }
}
