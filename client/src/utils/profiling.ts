export class LoadProfiler {
  private loadTimes: { [key: string]: number } = {};
  private loadStart: number;

  constructor() {
    this.loadStart = performance.now();
    this.loadTimes['scriptStart'] = this.loadStart;
  }

  markTime(name: string): void {
    this.loadTimes[name] = performance.now();
    const elapsed = (this.loadTimes[name] - this.loadStart).toFixed(2);
    console.log(`[PROFILE] ${name}: ${elapsed}ms`);
  }

  printSummary(): void {
    console.log('=== LOAD TIME SUMMARY ===');
    let prev = this.loadStart;
    for (const [name, time] of Object.entries(this.loadTimes)) {
      const elapsed = (time - this.loadStart).toFixed(2);
      const delta = (time - prev).toFixed(2);
      console.log(`${name}: +${delta}ms (total: ${elapsed}ms)`);
      prev = time;
    }
    const total = (performance.now() - this.loadStart).toFixed(2);
    console.log(`=== TOTAL: ${total}ms ===`);
  }
}
