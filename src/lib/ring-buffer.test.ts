import { describe, expect, it } from 'vitest'

import { RingBuffer } from './ring-buffer'

describe('RingBuffer', () => {
  it('starts empty', () => {
    const buffer = RingBuffer.create<number>(3)
    expect(buffer.size).toBe(0)
    expect(buffer.isEmpty).toBe(true)
    expect(buffer.isFull).toBe(false)
    expect(buffer.last()).toBeUndefined()
    expect(buffer.toArray()).toEqual([])
  })

  it('rejects a non-positive capacity', () => {
    expect(() => RingBuffer.create(0)).toThrow(RangeError)
    expect(() => RingBuffer.create(1.5)).toThrow(RangeError)
  })

  it('keeps insertion order below capacity', () => {
    const buffer = RingBuffer.create<number>(3).push(1).push(2)
    expect(buffer.toArray()).toEqual([1, 2])
    expect(buffer.first()).toBe(1)
    expect(buffer.last()).toBe(2)
    expect(buffer.isFull).toBe(false)
  })

  it('evicts the oldest item once full', () => {
    const buffer = RingBuffer.create<number>(3).push(1).push(2).push(3).push(4).push(5)
    expect(buffer.size).toBe(3)
    expect(buffer.isFull).toBe(true)
    expect(buffer.toArray()).toEqual([3, 4, 5])
    expect(buffer.last()).toBe(5)
  })

  it('is immutable: push returns a new instance and leaves the old one untouched', () => {
    const a = RingBuffer.create<string>(2).push('x')
    const b = a.push('y')
    expect(a.toArray()).toEqual(['x'])
    expect(b.toArray()).toEqual(['x', 'y'])
    expect(a).not.toBe(b)
  })

  it('seeds from an array and keeps only the newest items', () => {
    const buffer = RingBuffer.from([1, 2, 3, 4, 5], 3)
    expect(buffer.toArray()).toEqual([3, 4, 5])
    expect(RingBuffer.from([1], 3).toArray()).toEqual([1])
  })

  it('pushMany appends in order and truncates', () => {
    const buffer = RingBuffer.create<number>(4).push(1).pushMany([2, 3, 4, 5, 6])
    expect(buffer.toArray()).toEqual([3, 4, 5, 6])
    const same = buffer.pushMany([])
    expect(same).toBe(buffer)
  })

  it('tail returns the newest n items', () => {
    const buffer = RingBuffer.from([1, 2, 3, 4], 10)
    expect(buffer.tail(2)).toEqual([3, 4])
    expect(buffer.tail(10)).toEqual([1, 2, 3, 4])
    expect(buffer.tail(0)).toEqual([])
  })

  it('clear returns an empty buffer with the same capacity', () => {
    const buffer = RingBuffer.from([1, 2], 5).clear()
    expect(buffer.size).toBe(0)
    expect(buffer.capacity).toBe(5)
  })
})
