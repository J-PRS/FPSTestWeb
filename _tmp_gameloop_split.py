import io
p='src/game/gameLoop.ts'
s=io.open(p,encoding='utf-8').read()

a=s.index("  // FPS watchdog")
b=s.index("  function loop(time: number)")
block=s[a:b]
s=s[:a]+s[b:]

# de-indent
block='\n'.join(l[2:] if l.startswith('  ') else l for l in block.split('\n'))

# state bundle: fpsWatchdog counters, fx cursor, lastYaw/Pitch, fx jobs
ctx='''interface LoopState {
  lastYaw: number;
  lastPitch: number;
  lowFpsFrames: number;
  lowFpsAccum: number;
  lastFpsDump: number;
  fxCursor: number;
  fxJobs: (() => void)[];
}

'''
block=ctx+block

# rewrites: shared counters -> st.*, budget->deps-bound param? keep budget in deps? simplest: keep budget in loopState
block=block.replace("function fpsWatchdog(rawElapsed: number, now: number): void {",
                    "function fpsWatchdog(deps: GameLoopDeps, st: LoopState, budget: ReturnType<typeof createFrameBudget>, perf: ReturnType<typeof createPerfHud>, rawElapsed: number, now: number): void {")
block=block.replace("lowFpsFrames","st.lowFpsFrames")
block=block.replace("lowFpsAccum","st.lowFpsAccum")
block=block.replace("lastFpsDump","st.lastFpsDump")
block=block.replace("function tickDemo(dt: number): boolean {","function tickDemo(deps: GameLoopDeps, dt: number): boolean {")
block=block.replace("function censusEntities(entities: ReturnType<typeof createEntities>) {","function censusEntities(deps: GameLoopDeps, entities: ReturnType<typeof createEntities>) {")
block=block.replace("function syncFog(terrain: Terrain): void {","function syncFog(deps: GameLoopDeps, terrain: Terrain): void {")
block=block.replace("function simTick(dt: number, player: Player, terrain: Terrain, networkManager: NetworkManager, demoManager: DemoManager | null): boolean {",
                    "function simTick(deps: GameLoopDeps, perf: ReturnType<typeof createPerfHud>, dt: number, player: Player, terrain: Terrain, networkManager: NetworkManager, demoManager: DemoManager | null): boolean {")
block=block.replace("syncFog(terrain);","syncFog(deps, terrain);")
block=block.replace("const demoPaused = tickDemo(dt);","const demoPaused = tickDemo(deps, dt);")
block=block.replace("tickEntities(dt, demoManager?.isPlaying ?? false);","tickEntities(deps, perf, dt, demoManager?.isPlaying ?? false);")
block=block.replace("function tickEntities(dt: number, demoPlaying: boolean): void {","function tickEntities(deps: GameLoopDeps, perf: ReturnType<typeof createPerfHud>, dt: number, demoPlaying: boolean): void {")
block=block.replace("  const FX_MS_CAP = 1.2;\n  const _fxJobs: (() => void)[] = [];\n  let _fxCursor = 0;\n","")
block=block.replace("function fxTick(fxDt: number): void {","const FX_MS_CAP = 1.2;\nfunction fxTick(deps: GameLoopDeps, st: LoopState, budget: ReturnType<typeof createFrameBudget>, fxDt: number): void {")
block=block.replace("_fxJobs","st.fxJobs")
block=block.replace("_fxCursor","st.fxCursor")
block=block.replace("function hudTick(dt: number, fxDt: number, player: Player, networkManager: NetworkManager, demoManager: DemoManager | null): void {",
                    "function hudTick(deps: GameLoopDeps, st: LoopState, budget: ReturnType<typeof createFrameBudget>, perf: ReturnType<typeof createPerfHud>, dt: number, fxDt: number, player: Player, networkManager: NetworkManager, demoManager: DemoManager | null): void {")
block=block.replace("censusEntities(entities)","censusEntities(deps, entities)")
block=block.replace("lastPlayerYaw","st.lastYaw")
block=block.replace("lastPlayerPitch","st.lastPitch")
block=block.replace("function renderFrame(dt: number): void {","function renderFrame(deps: GameLoopDeps, dt: number): void {")

s=s.replace("// The frame loop + render pass.","",0)
s=s.replace("export function createGameLoop", block+"\nexport function createGameLoop",1)

# factory rewrites
s=s.replace("  let lastPlayerYaw = 0;\n  let lastPlayerPitch = 0;\n","  const st: LoopState = { lastYaw: 0, lastPitch: 0, lowFpsFrames: 0, lowFpsAccum: 0, lastFpsDump: 0, fxCursor: 0, fxJobs: [] };\n")
s=s.replace("fpsWatchdog(rawElapsed, time);","fpsWatchdog(deps, st, budget, perf, rawElapsed, time);")
s=s.replace("const demoPaused = simTick(dt, player, terrain, networkManager, demoManager);",
            "const demoPaused = simTick(deps, perf, dt, player, terrain, networkManager, demoManager);")
s=s.replace("if (!demoPaused) fxTick(fxDt);","if (!demoPaused) fxTick(deps, st, budget, fxDt);")
s=s.replace("hudTick(dt, fxDt, player, networkManager, demoManager);","hudTick(deps, st, budget, perf, dt, fxDt, player, networkManager, demoManager);")
s=s.replace("renderFrame(fxDt);","renderFrame(deps, fxDt);")
io.open(p,'w',encoding='utf-8').write(s)
print('ok')
