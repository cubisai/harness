// Map and Set that keep only the newest `cap` keys (a read counts as use), for
// caches that must not grow with every session.

export class BoundedMap<K, V> extends Map<K, V> {
  constructor(private readonly cap: number) {
    super();
  }

  override get(key: K): V | undefined {
    if (!super.has(key)) return undefined;
    const value = super.get(key) as V;
    super.delete(key);
    super.set(key, value);
    return value;
  }

  override set(key: K, value: V): this {
    super.delete(key);
    super.set(key, value);
    while (this.size > this.cap) super.delete(this.keys().next().value as K);
    return this;
  }
}

export class BoundedSet<T> extends Set<T> {
  constructor(private readonly cap: number) {
    super();
  }

  override has(value: T): boolean {
    if (!super.has(value)) return false;
    super.delete(value);
    super.add(value);
    return true;
  }

  override add(value: T): this {
    super.delete(value);
    super.add(value);
    while (this.size > this.cap) super.delete(this.values().next().value as T);
    return this;
  }
}
