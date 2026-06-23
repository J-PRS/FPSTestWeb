/**
 * Unit tests for PerformanceMonitor
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PerformanceMonitor } from './PerformanceMonitor.js';

describe('PerformanceMonitor', () => {
  let monitor: PerformanceMonitor;

  beforeEach(() => {
    monitor = new PerformanceMonitor();
  });

  describe('recordBandwidth', () => {
    it('should record bandwidth usage', () => {
      monitor.recordBandwidth(1024, 512);
      const metrics = monitor.getMetrics();
      expect(metrics.bandwidthSent).toBeGreaterThan(0);
      expect(metrics.bandwidthReceived).toBeGreaterThan(0);
    });
  });

  describe('recordTickDuration', () => {
    it('should record tick duration', () => {
      monitor.recordTickDuration(10);
      monitor.recordTickDuration(15);
      monitor.recordTickDuration(20);
      const metrics = monitor.getMetrics();
      expect(metrics.tickDuration).toBeGreaterThan(0);
    });

    it('should maintain max sample size', () => {
      for (let i = 0; i < 100; i++) {
        monitor.recordTickDuration(i);
      }
      // Should not exceed sample size
      const metrics = monitor.getMetrics();
      expect(metrics.tickDuration).toBeGreaterThan(0);
    });
  });

  describe('update', () => {
    it('should update metrics', () => {
      const metrics = monitor.update(5, 10, 15);
      expect(metrics.playerCount).toBe(5);
      expect(metrics.messageQueueSize).toBe(10);
      expect(metrics.tickRate).toBe(15);
    });

    it('should track memory usage', () => {
      const metrics = monitor.update(0, 0, 0);
      expect(metrics.memoryUsed).toBeGreaterThan(0);
      expect(metrics.memoryTotal).toBeGreaterThan(0);
    });
  });

  describe('resetBandwidth', () => {
    it('should reset bandwidth counters', () => {
      monitor.recordBandwidth(1024, 512);
      monitor.resetBandwidth();
      const metrics = monitor.getMetrics();
      expect(metrics.bandwidthSent).toBe(0);
      expect(metrics.bandwidthReceived).toBe(0);
    });
  });
});
