/**
 * Performance monitoring for server
 * Tracks CPU, memory, bandwidth, and message queue metrics
 */

import { Logger } from './Logger.js';

interface PerformanceMetrics {
  cpuUsage: number;
  memoryUsage: number;
  memoryUsed: number;
  memoryTotal: number;
  bandwidthSent: number;
  bandwidthReceived: number;
  messageQueueSize: number;
  playerCount: number;
  tickRate: number;
  tickDuration: number;
}

export class PerformanceMonitor {
  private metrics: PerformanceMetrics;
  private startTime: number;
  private lastCpuTime: number;
  private lastCheckTime: number;
  private bandwidthSent: number = 0;
  private bandwidthReceived: number = 0;
  private tickDurations: number[] = [];
  private readonly TICK_DURATION_SAMPLES = 60; // Keep last 60 tick durations
  private readonly MONITOR_INTERVAL_MS = 5000; // Log every 5 seconds

  constructor() {
    this.metrics = {
      cpuUsage: 0,
      memoryUsage: 0,
      memoryUsed: 0,
      memoryTotal: 0,
      bandwidthSent: 0,
      bandwidthReceived: 0,
      messageQueueSize: 0,
      playerCount: 0,
      tickRate: 0,
      tickDuration: 0
    };
    this.startTime = Date.now();
    this.lastCpuTime = process.cpuUsage().user;
    this.lastCheckTime = Date.now();
  }

  /**
   * Record bandwidth usage
   */
  recordBandwidth(sent: number, received: number): void {
    this.bandwidthSent += sent;
    this.bandwidthReceived += received;
  }

  /**
   * Record tick duration
   */
  recordTickDuration(duration: number): void {
    this.tickDurations.push(duration);
    if (this.tickDurations.length > this.TICK_DURATION_SAMPLES) {
      this.tickDurations.shift();
    }
  }

  /**
   * Update metrics and return current state
   */
  update(playerCount: number, messageQueueSize: number, tickRate: number): PerformanceMetrics {
    const now = Date.now();
    const elapsed = now - this.lastCheckTime;

    // Update CPU usage
    const cpuUsage = process.cpuUsage();
    const cpuDelta = (cpuUsage.user - this.lastCpuTime) / 1000; // Convert to milliseconds
    this.metrics.cpuUsage = (cpuDelta / elapsed) * 100; // Percentage
    this.lastCpuTime = cpuUsage.user;
    this.lastCheckTime = now;

    // Update memory usage
    const memoryUsage = process.memoryUsage();
    this.metrics.memoryUsed = memoryUsage.heapUsed / 1024 / 1024; // MB
    this.metrics.memoryTotal = memoryUsage.heapTotal / 1024 / 1024; // MB
    this.metrics.memoryUsage = (memoryUsage.heapUsed / memoryUsage.heapTotal) * 100; // Percentage

    // Update bandwidth (reset after logging)
    this.metrics.bandwidthSent = this.bandwidthSent / 1024; // KB
    this.metrics.bandwidthReceived = this.bandwidthReceived / 1024; // KB

    // Update other metrics
    this.metrics.messageQueueSize = messageQueueSize;
    this.metrics.playerCount = playerCount;
    this.metrics.tickRate = tickRate;

    // Calculate average tick duration
    if (this.tickDurations.length > 0) {
      const avgDuration = this.tickDurations.reduce((a, b) => a + b, 0) / this.tickDurations.length;
      this.metrics.tickDuration = avgDuration;
    }

    return this.metrics;
  }

  /**
   * Reset bandwidth counters (called after logging)
   */
  resetBandwidth(): void {
    this.bandwidthSent = 0;
    this.bandwidthReceived = 0;
  }

  /**
   * Log current metrics
   */
  logMetrics(): void {
    const m = this.metrics;
    Logger.info(
      `Performance: CPU=${m.cpuUsage.toFixed(1)}% ` +
      `Memory=${m.memoryUsed.toFixed(1)}MB/${m.memoryTotal.toFixed(1)}MB (${m.memoryUsage.toFixed(1)}%) ` +
      `Bandwidth=↑${m.bandwidthSent.toFixed(1)}KB ↓${m.bandwidthReceived.toFixed(1)}KB ` +
      `Players=${m.playerCount} ` +
      `Queue=${m.messageQueueSize} ` +
      `Tick=${m.tickRate}Hz (${m.tickDuration.toFixed(2)}ms)`
    );
    this.resetBandwidth();
  }

  /**
   * Start periodic monitoring
   */
  startMonitoring(getMetricsContext: () => { playerCount: number; messageQueueSize: number; tickRate: number }): void {
    setInterval(() => {
      const context = getMetricsContext();
      this.update(context.playerCount, context.messageQueueSize, context.tickRate);
      this.logMetrics();
    }, this.MONITOR_INTERVAL_MS);
  }

  /**
   * Get current metrics without updating
   */
  getMetrics(): PerformanceMetrics {
    return { ...this.metrics };
  }
}
