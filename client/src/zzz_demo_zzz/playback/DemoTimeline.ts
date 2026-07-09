/**
 * Timeline event for demo playback.
 */
export interface TimelineEvent {
  /** Event ID */
  id: string;
  /** Event type */
  type: 'projectile' | 'target' | 'bookmark' | 'custom';
  /** Timestamp */
  timestamp: number;
  /** Event data */
  data: any;
  /** Color for UI */
  color: string;
  /** Label */
  label: string;
}

/**
 * Demo timeline component.
 * Visualizes demo events and provides scrubbing functionality.
 */
export class DemoTimeline {
  private events: TimelineEvent[] = [];
  private duration: number = 0;
  private currentTime: number = 0;
  private zoom: number = 1;
  private scrollOffset: number = 0;

  /**
   * Set demo duration.
   * @param duration - Duration in seconds
   */
  setDuration(duration: number): void {
    this.duration = duration;
  }

  /**
   * Get demo duration.
   * @returns Duration in seconds
   */
  getDuration(): number {
    return this.duration;
  }

  /**
   * Set current playback time.
   * @param time - Current time in seconds
   */
  setCurrentTime(time: number): void {
    this.currentTime = Math.max(0, Math.min(time, this.duration));
  }

  /**
   * Get current playback time.
   * @returns Current time in seconds
   */
  getCurrentTime(): number {
    return this.currentTime;
  }

  /**
   * Add an event to the timeline.
   * @param event - Timeline event
   */
  addEvent(event: TimelineEvent): void {
    this.events.push(event);
    this.events.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Remove an event from the timeline.
   * @param id - Event ID
   */
  removeEvent(id: string): void {
    this.events = this.events.filter((e) => e.id !== id);
  }

  /**
   * Get all events.
   * @returns Array of timeline events
   */
  getEvents(): TimelineEvent[] {
    return this.events;
  }

  /**
   * Get events in a time range.
   * @param startTime - Start time
   * @param endTime - End time
   * @returns Array of events in range
   */
  getEventsInRange(startTime: number, endTime: number): TimelineEvent[] {
    return this.events.filter((e) => e.timestamp >= startTime && e.timestamp <= endTime);
  }

  /**
   * Get events near a timestamp.
   * @param timestamp - Target timestamp
   * @param tolerance - Time tolerance in seconds
   * @returns Array of nearby events
   */
  getEventsNear(timestamp: number, tolerance: number = 0.5): TimelineEvent[] {
    return this.events.filter((e) => Math.abs(e.timestamp - timestamp) <= tolerance);
  }

  /**
   * Find the next event after a timestamp.
   * @param timestamp - Current timestamp
   * @returns Next event or undefined
   */
  findNextEvent(timestamp: number): TimelineEvent | undefined {
    return this.events.find((e) => e.timestamp > timestamp);
  }

  /**
   * Find the previous event before a timestamp.
   * @param timestamp - Current timestamp
   * @returns Previous event or undefined
   */
  findPreviousEvent(timestamp: number): TimelineEvent | undefined {
    const reversed = [...this.events].reverse();
    return reversed.find((e) => e.timestamp < timestamp);
  }

  /**
   * Jump to the next event.
   * @returns New timestamp or undefined
   */
  jumpToNextEvent(): number | undefined {
    const nextEvent = this.findNextEvent(this.currentTime);
    if (nextEvent) {
      this.setCurrentTime(nextEvent.timestamp);
      return nextEvent.timestamp;
    }
    return undefined;
  }

  /**
   * Jump to the previous event.
   * @returns New timestamp or undefined
   */
  jumpToPreviousEvent(): number | undefined {
    const prevEvent = this.findPreviousEvent(this.currentTime);
    if (prevEvent) {
      this.setCurrentTime(prevEvent.timestamp);
      return prevEvent.timestamp;
    }
    return undefined;
  }

  /**
   * Set zoom level.
   * @param zoom - Zoom level (1 = normal, >1 = zoomed in)
   */
  setZoom(zoom: number): void {
    this.zoom = Math.max(0.1, Math.min(zoom, 10));
  }

  /**
   * Get zoom level.
   * @returns Zoom level
   */
  getZoom(): number {
    return this.zoom;
  }

  /**
   * Set scroll offset.
   * @param offset - Scroll offset in seconds
   */
  setScrollOffset(offset: number): void {
    this.scrollOffset = Math.max(0, Math.min(offset, this.duration));
  }

  /**
   * Get scroll offset.
   * @returns Scroll offset in seconds
   */
  getScrollOffset(): number {
    return this.scrollOffset;
  }

  /**
   * Convert time to screen X position.
   * @param time - Time in seconds
   * @param width - Timeline width in pixels
   * @returns X position in pixels
   */
  timeToScreenX(time: number, width: number): number {
    const visibleDuration = this.duration / this.zoom;
    const relativeTime = time - this.scrollOffset;
    return (relativeTime / visibleDuration) * width;
  }

  /**
   * Convert screen X position to time.
   * @param x - X position in pixels
   * @param width - Timeline width in pixels
   * @returns Time in seconds
   */
  screenXToTime(x: number, width: number): number {
    const visibleDuration = this.duration / this.zoom;
    const relativeTime = (x / width) * visibleDuration;
    return this.scrollOffset + relativeTime;
  }

  /**
   * Clear all events.
   */
  clearEvents(): void {
    this.events = [];
  }

  /**
   * Get event count.
   * @returns Number of events
   */
  getEventCount(): number {
    return this.events.length;
  }

  /**
   * Get visible events based on zoom and scroll.
   * @param width - Timeline width in pixels
   * @returns Array of visible events
   */
  getVisibleEvents(width: number): TimelineEvent[] {
    const visibleDuration = this.duration / this.zoom;
    const startTime = this.scrollOffset;
    const endTime = startTime + visibleDuration;

    return this.getEventsInRange(startTime, endTime);
  }
}
